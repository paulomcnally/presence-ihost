package main

import (
	"bytes"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

var (
	dbPath = getenv("SETTINGS_DB", "/app/data/presence.db")
	webDir = getenv("WEB_ROOT", "dist")
	port   = getenv("SETTINGS_PORT", "8082")
	db     *sql.DB
)

const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"

// voiceMonkeyVoice: Amazon Polly voice used for VoiceMonkey announcements.
// Matches the working integration in p40la-ihost (Spanish voice).
const voiceMonkeyVoice = "Lucia"

var (
	macRe               = regexp.MustCompile(`^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$`)
	ifaceRe             = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)
	controlRe           = regexp.MustCompile(`[\x00-\x1f\x7f]`)
	devicePlaceholderRe = regexp.MustCompile(`\{device_[^}]*\}`)
)

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func ensureSchema() error {
	_, err := db.Exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mac  TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS voicemonkey (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  enabled   INTEGER NOT NULL DEFAULT 0,
  api_key   TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  message   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS presence (
  mac       TEXT PRIMARY KEY,
  present   INTEGER NOT NULL DEFAULT 0,
  last_seen REAL,
  ip        TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`)
	return err
}

func seedDefaults() error {
	defaults := map[string]string{
		"grace":       "180",
		"ifaces":      "",
		"scan_prefix": "24",
		"webhook_url": "",
		"log_level":   "INFO",
	}
	for k, v := range defaults {
		_, err := db.Exec("INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)", k, v)
		if err != nil {
			return err
		}
	}
	_, err := db.Exec("INSERT OR IGNORE INTO voicemonkey(id) VALUES(1)")
	return err
}

func loadSettings() (map[string]string, error) {
	rows, err := db.Query("SELECT key, value FROM settings")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

func loadSetting(key string) string {
	row := db.QueryRow("SELECT value FROM settings WHERE key = ?", key)
	var v string
	if err := row.Scan(&v); err != nil {
		return ""
	}
	return v
}

func upsertSetting(key, value string) error {
	_, err := db.Exec("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value)
	return err
}

func loadDevices() ([]map[string]any, error) {
	rows, err := db.Query("SELECT id, name, mac FROM devices ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var name, mac string
		if err := rows.Scan(&id, &name, &mac); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"id": id, "name": name, "mac": mac})
	}
	return out, rows.Err()
}

func currentAPIKey() string {
	row := db.QueryRow("SELECT api_key FROM voicemonkey WHERE id = 1")
	var key string
	if err := row.Scan(&key); err != nil {
		return ""
	}
	return key
}

func loadVoiceMonkey() (map[string]any, error) {
	row := db.QueryRow("SELECT enabled, api_key, device_id, message FROM voicemonkey WHERE id = 1")
	var enabled int
	var apiKey, deviceID, message string
	if err := row.Scan(&enabled, &apiKey, &deviceID, &message); err != nil {
		if err == sql.ErrNoRows {
			return map[string]any{"enabled": false, "api_key_masked": "", "api_key_set": false, "device_id": "", "message": ""}, nil
		}
		return nil, err
	}
	return map[string]any{
		"enabled":        enabled != 0,
		"api_key_masked": maskAPIKey(apiKey),
		"api_key_set":    apiKey != "",
		"device_id":      deviceID,
		"message":        message,
	}, nil
}

func lastJobRun() any {
	var v sql.NullString
	if err := db.QueryRow("SELECT value FROM meta WHERE key = 'last_job_run'").Scan(&v); err != nil || !v.Valid {
		return nil
	}
	return v.String
}

func configPayload() (map[string]any, error) {
	settings, err := loadSettings()
	if err != nil {
		return nil, err
	}
	devices, err := loadDevices()
	if err != nil {
		return nil, err
	}
	vm, err := loadVoiceMonkey()
	if err != nil {
		return nil, err
	}
	for k := range settings {
		if strings.HasPrefix(k, "auth_") {
			delete(settings, k)
		}
	}
	return map[string]any{
		"settings":     settings,
		"devices":      devices,
		"voicemonkey":  vm,
		"last_job_run": lastJobRun(),
	}, nil
}

func maskAPIKey(key string) string {
	key = strings.TrimSpace(key)
	if key == "" {
		return ""
	}
	if len(key) <= 9 {
		return strings.Repeat("•", len(key))
	}
	return key[:5] + "-…-" + key[len(key)-4:]
}

func normalizeMAC(v string) string {
	s := strings.ToLower(strings.TrimSpace(v))
	s = strings.ReplaceAll(s, "-", ":")
	s = strings.ReplaceAll(s, ".", ":")
	return s
}

// validatePayload returns blocking per-field errors and non-blocking warnings.
func validatePayload(payload map[string]any) (map[string]string, map[string]string) {
	errors := map[string]string{}
	warnings := map[string]string{}

	if settings, ok := payload["settings"].(map[string]any); ok {
		if g, ok := settings["grace"]; ok {
			n, err := strconv.Atoi(strings.TrimSpace(fmt.Sprint(g)))
			if err != nil || n < 10 || n > 3600 {
				errors["grace"] = "Debe estar entre 10 y 3600 segundos"
			}
		}
		if sp, ok := settings["scan_prefix"]; ok {
			n, err := strconv.Atoi(strings.TrimSpace(fmt.Sprint(sp)))
			if err != nil || n < 16 || n > 30 {
				errors["scan_prefix"] = "Debe estar entre 16 y 30"
			}
		}
		if ifs, ok := settings["ifaces"]; ok {
			val := strings.TrimSpace(fmt.Sprint(ifs))
			if val != "" {
				for _, token := range strings.Split(val, ",") {
					token = strings.TrimSpace(token)
					if token != "" && !ifaceRe.MatchString(token) {
						errors["ifaces"] = "Nombre de interfaz inválido"
						break
					}
				}
			}
		}
		if wh, ok := settings["webhook_url"]; ok {
			val := strings.TrimSpace(fmt.Sprint(wh))
			if val != "" {
				u, err := url.Parse(val)
				if err != nil || u.Scheme == "" || u.Host == "" {
					errors["webhook_url"] = "URL inválida"
				} else if u.Scheme != "http" && u.Scheme != "https" {
					errors["webhook_url"] = "URL inválida"
				} else if u.Scheme == "http" {
					host := u.Hostname()
					if ip := net.ParseIP(host); ip != nil || host == "localhost" || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".lan") {
						warnings["webhook_url"] = "Usando http:// sin cifrar en tu LAN"
					} else {
						errors["webhook_url"] = "URL no segura: usa https://"
					}
				}
			}
		}
	}

	if devices, ok := payload["devices"].([]any); ok {
		seen := map[string]bool{}
		for i, d := range devices {
			item, ok := d.(map[string]any)
			if !ok {
				continue
			}
			key := fmt.Sprintf("devices[%d]", i)
			name := strings.TrimSpace(fmt.Sprint(item["name"]))
			macRaw := strings.TrimSpace(fmt.Sprint(item["mac"]))
			if name == "" {
				errors[key+".name"] = "El nombre no puede estar vacío"
			} else if len(name) > 64 {
				errors[key+".name"] = "Máximo 64 caracteres"
			} else if controlRe.MatchString(name) {
				errors[key+".name"] = "El nombre contiene caracteres no válidos"
			}
			mac := normalizeMAC(macRaw)
			if macRaw == "" {
				errors[key+".mac"] = "La MAC no puede estar vacía"
			} else if !macRe.MatchString(mac) {
				errors[key+".mac"] = "MAC inválida. Formato: aa:bb:cc:dd:ee:ff"
			} else if seen[mac] {
				errors[key+".mac"] = "Ya existe un dispositivo con esta MAC"
			} else {
				seen[mac] = true
			}
		}
	}

	if vm, ok := payload["voicemonkey"].(map[string]any); ok {
		enabled, _ := vm["enabled"].(bool)
		if enabled {
			effKey := strings.TrimSpace(fmt.Sprint(vm["api_key"]))
			if effKey == "" || effKey == maskAPIKey(currentAPIKey()) {
				effKey = currentAPIKey()
			}
			if effKey == "" {
				errors["voicemonkey.api_key"] = "Requerido si los anuncios están activos"
			}
			if strings.TrimSpace(fmt.Sprint(vm["device_id"])) == "" {
				errors["voicemonkey.device_id"] = "Requerido si los anuncios están activos"
			}
		}
		if msg, ok := vm["message"]; ok {
			val := fmt.Sprint(msg)
			for _, m := range devicePlaceholderRe.FindAllString(val, -1) {
				if m != "{device_name}" {
					warnings["voicemonkey.message"] = "¿Quisiste decir `{device_name}`?"
					break
				}
			}
		}
	}

	return errors, warnings
}

func writeConfig(payload map[string]any) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if settings, ok := payload["settings"].(map[string]any); ok {
		for k, v := range settings {
			if strings.HasPrefix(k, "auth_") {
				continue
			}
			val, _ := v.(string)
			if _, err := tx.Exec("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", k, val); err != nil {
				return err
			}
		}
	}

	if devices, ok := payload["devices"].([]any); ok {
		if _, err := tx.Exec("DELETE FROM devices"); err != nil {
			return err
		}
		for _, d := range devices {
			item, ok := d.(map[string]any)
			if !ok {
				continue
			}
			name, _ := item["name"].(string)
			mac, _ := item["mac"].(string)
			if strings.TrimSpace(name) == "" || strings.TrimSpace(mac) == "" {
				continue
			}
			if _, err := tx.Exec("INSERT INTO devices(name, mac) VALUES(?, ?)", strings.TrimSpace(name), normalizeMAC(mac)); err != nil {
				return err
			}
		}
	}

	if vm, ok := payload["voicemonkey"].(map[string]any); ok {
		enabled := 0
		if e, ok := vm["enabled"].(bool); ok && e {
			enabled = 1
		}
		storedKey := currentAPIKey()
		apiKey := strings.TrimSpace(fmt.Sprint(vm["api_key"]))
		if apiKey == "" || apiKey == maskAPIKey(storedKey) {
			apiKey = storedKey
		}
		deviceID, _ := vm["device_id"].(string)
		message, _ := vm["message"].(string)
		if _, err := tx.Exec(
			"INSERT INTO voicemonkey(id, enabled, api_key, device_id, message) VALUES(1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, api_key = excluded.api_key, device_id = excluded.device_id, message = excluded.message",
			enabled, apiKey, strings.TrimSpace(deviceID), message,
		); err != nil {
			return err
		}
	}

	return tx.Commit()
}

func announceVoiceMonkey(apiKey, deviceID, speech string) error {
	body, err := json.Marshal(map[string]string{
		"token":  apiKey,
		"device": deviceID,
		"speech": speech,
		"voice":  voiceMonkeyVoice,
	})
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post("https://api-v3.voicemonkey.io/announce", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("voicemonkey returned status %d", resp.StatusCode)
	}
	return nil
}

func postJSON(rawURL string, body any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post(rawURL, "application/json", bytes.NewReader(data))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("el destino respondió %d", resp.StatusCode)
	}
	return nil
}

func nowIso() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func jsonOK(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(data)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func xRequestedWith(r *http.Request) bool {
	return r.Header.Get("X-Requested-With") == "XMLHttpRequest"
}

// ---- Auth ----

func authConfig() (username, hash string, configured bool) {
	settings, err := loadSettings()
	if err != nil {
		settings = map[string]string{}
	}
	username = settings["auth_username"]
	hash = settings["auth_password_hash"]
	if username == "" {
		username = os.Getenv("SETTINGS_USERNAME")
	}
	if hash == "" {
		hash = os.Getenv("SETTINGS_PASSWORD_HASH")
	}
	configured = username != "" && hash != ""
	return
}

func authSkipped() bool {
	settings, err := loadSettings()
	if err != nil {
		return false
	}
	return settings["auth_skipped"] == "1"
}

func validBasic(r *http.Request, username, hash string) bool {
	u, p, ok := r.BasicAuth()
	if !ok {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(u), []byte(username)) != 1 {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(p)) == nil
}

// requireAuth protects /api/* (except /api/auth/*). When credentials are set it
// demands HTTP Basic Auth; on a fresh install (no credentials, not skipped) it
// blocks everything until the setup wizard creates access.
func requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/auth/") {
			next(w, r)
			return
		}
		username, hash, configured := authConfig()
		if configured {
			if !validBasic(r, username, hash) {
				w.Header().Set("WWW-Authenticate", `Basic realm="presence-ihost"`)
				writeErr(w, http.StatusUnauthorized, "autenticación requerida")
				return
			}
		} else if !authSkipped() {
			writeErr(w, http.StatusForbidden, "setup_required")
			return
		}
		next(w, r)
	}
}

func handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	_, _, configured := authConfig()
	jsonOK(w, map[string]any{"configured": configured, "skipped": authSkipped()})
}

func handleAuthSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !xRequestedWith(r) {
		writeErr(w, http.StatusForbidden, "forbidden")
		return
	}
	if !setupLimiter.allow(clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests, "Demasiadas peticiones, espera un momento")
		return
	}
	var payload struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Skip     bool   `json:"skip"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON inválido")
		return
	}
	if _, _, configured := authConfig(); configured {
		writeErr(w, http.StatusConflict, "already_configured")
		return
	}
	if payload.Skip {
		if err := upsertSetting("auth_skipped", "1"); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		jsonOK(w, map[string]any{"ok": true})
		return
	}
	username := strings.TrimSpace(payload.Username)
	if username == "" || len(username) > 64 || controlRe.MatchString(username) {
		writeErr(w, http.StatusBadRequest, "Nombre de usuario no válido")
		return
	}
	if len(payload.Password) < 8 {
		writeErr(w, http.StatusBadRequest, "La contraseña debe tener al menos 8 caracteres")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(payload.Password), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := upsertSetting("auth_username", username); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := upsertSetting("auth_password_hash", string(hash)); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if _, err := db.Exec("DELETE FROM settings WHERE key = 'auth_skipped'"); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	jsonOK(w, map[string]any{"ok": true})
}

// ---- Rate limiting ----

type rateLimiter struct {
	mu    sync.Mutex
	hits  map[string][]time.Time
	limit int
	win   time.Duration
}

func newRateLimiter(limit int, win time.Duration) *rateLimiter {
	return &rateLimiter{hits: map[string][]time.Time{}, limit: limit, win: win}
}

func (rl *rateLimiter) allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-rl.win)
	kept := rl.hits[key][:0]
	for _, t := range rl.hits[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	rl.hits[key] = kept
	if len(kept) >= rl.limit {
		return false
	}
	rl.hits[key] = append(rl.hits[key], now)
	return true
}

var (
	configLimiter = newRateLimiter(5, time.Minute)
	testLimiter   = newRateLimiter(5, time.Minute)
	setupLimiter  = newRateLimiter(5, time.Minute)
	whTestLimiter = newRateLimiter(5, time.Minute)
)

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ---- Handlers ----

func handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		payload, err := configPayload()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		jsonOK(w, payload)
	case http.MethodPut:
		if !xRequestedWith(r) {
			writeErr(w, http.StatusForbidden, "forbidden")
			return
		}
		if !configLimiter.allow(clientIP(r)) {
			writeErr(w, http.StatusTooManyRequests, "Demasiadas peticiones, espera un momento")
			return
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		errors, warnings := validatePayload(payload)
		if len(errors) > 0 {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]any{"errors": errors})
			return
		}
		if err := writeConfig(payload); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		out, _ := configPayload()
		if len(warnings) > 0 {
			out["warnings"] = warnings
		}
		jsonOK(w, out)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func handlePresence(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	rows, err := db.Query("SELECT d.name, d.mac, COALESCE(p.present, 0), p.ip, p.last_seen FROM devices d LEFT JOIN presence p ON d.mac = p.mac ORDER BY d.id")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	devices := []map[string]any{}
	anyone := false
	for rows.Next() {
		var name, mac string
		var present int
		var ip sql.NullString
		var lastSeen sql.NullFloat64
		if err := rows.Scan(&name, &mac, &present, &ip, &lastSeen); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		devices = append(devices, map[string]any{
			"name":      name,
			"mac":       mac,
			"present":   present != 0,
			"ip":        ip.String,
			"last_seen": lastSeen.Float64,
		})
		if present != 0 {
			anyone = true
		}
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	jsonOK(w, map[string]any{"anyone_home": anyone, "devices": devices, "last_job_run": lastJobRun()})
}

func handleTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !xRequestedWith(r) {
		writeErr(w, http.StatusForbidden, "forbidden")
		return
	}
	if !testLimiter.allow(clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests, "Demasiadas peticiones, espera un momento")
		return
	}
	var payload map[string]any
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	apiKey := strings.TrimSpace(fmt.Sprint(payload["api_key"]))
	deviceID := strings.TrimSpace(fmt.Sprint(payload["device_id"]))
	speech, _ := payload["message"].(string)
	stored := currentAPIKey()
	if apiKey == "" || apiKey == maskAPIKey(stored) {
		apiKey = stored
	}
	if apiKey == "" {
		writeErr(w, http.StatusBadRequest, "Falta la API Key de VoiceMonkey")
		return
	}
	if deviceID == "" {
		writeErr(w, http.StatusBadRequest, "Falta el Device ID de VoiceMonkey")
		return
	}
	if speech == "" {
		speech = "Hola, prueba de presencia"
	}
	if err := announceVoiceMonkey(apiKey, deviceID, speech); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	jsonOK(w, map[string]string{"status": "ok"})
}

func handleWebhookTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !xRequestedWith(r) {
		writeErr(w, http.StatusForbidden, "forbidden")
		return
	}
	if !whTestLimiter.allow(clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests, "Demasiadas peticiones, espera un momento")
		return
	}
	var payload struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	rawURL := strings.TrimSpace(payload.URL)
	if rawURL == "" {
		rawURL = loadSetting("webhook_url")
	}
	if rawURL == "" {
		writeErr(w, http.StatusBadRequest, "No hay URL de webhook configurada")
		return
	}
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		writeErr(w, http.StatusBadRequest, "URL inválida")
		return
	}
	body := map[string]any{
		"event":   "test",
		"ts":      nowIso(),
		"message": "Evento de prueba de Presence iHost",
	}
	if err := postJSON(rawURL, body); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	jsonOK(w, map[string]string{"status": "ok"})
}

func handleLog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	path := getenv("LOG_FILE", "/app/data/presence.log")
	lines := 40
	if n := r.URL.Query().Get("lines"); n != "" {
		if v, err := strconv.Atoi(n); err == nil && v > 0 && v <= 500 {
			lines = v
		}
	}
	content, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			jsonOK(w, map[string]any{"file": path, "lines": []string{}, "exists": false})
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	all := strings.Split(strings.TrimRight(string(content), "\n"), "\n")
	if all[0] == "" {
		all = nil
	}
	start := 0
	if len(all) > lines {
		start = len(all) - lines
	}
	jsonOK(w, map[string]any{"file": path, "lines": all[start:], "exists": true})
}

func withCommon(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := getenv("SETTINGS_CORS_ORIGIN", ""); origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Requested-With, Authorization")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func spaHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		clean := filepath.Clean(r.URL.Path)
		file := filepath.Join(webDir, clean)
		if info, err := os.Stat(file); err == nil && !info.IsDir() {
			if strings.HasSuffix(file, ".html") {
				w.Header().Set("Content-Security-Policy", csp)
			}
			http.ServeFile(w, r, file)
			return
		}
		w.Header().Set("Content-Security-Policy", csp)
		http.ServeFile(w, r, filepath.Join(webDir, "index.html"))
	})
}

func main() {
	var err error
	db, err = sql.Open("sqlite", dbPath+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		log.Fatal(err)
	}
	if err := ensureSchema(); err != nil {
		log.Fatal(err)
	}
	if err := seedDefaults(); err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/auth/status", handleAuthStatus)
	mux.HandleFunc("/api/auth/setup", handleAuthSetup)
	mux.HandleFunc("/api/config", requireAuth(handleConfig))
	mux.HandleFunc("/api/presence", requireAuth(handlePresence))
	mux.HandleFunc("/api/voicemonkey/test", requireAuth(handleTest))
	mux.HandleFunc("/api/webhook/test", requireAuth(handleWebhookTest))
	mux.HandleFunc("/api/log", requireAuth(handleLog))
	mux.Handle("/", spaHandler())

	log.Printf("settings server listening on 0.0.0.0:%s (db=%s web=%s)", port, dbPath, webDir)
	if err := http.ListenAndServe("0.0.0.0:"+port, withCommon(mux)); err != nil {
		log.Fatal(err)
	}
}
