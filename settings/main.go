package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var (
	dbPath = getenv("SETTINGS_DB", "/app/data/presence.db")
	webDir = getenv("WEB_ROOT", "dist")
	port   = getenv("SETTINGS_PORT", "8082")
	db     *sql.DB
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

func loadVoiceMonkey() (map[string]any, error) {
	row := db.QueryRow("SELECT enabled, api_key, device_id, message FROM voicemonkey WHERE id = 1")
	var enabled int
	var apiKey, deviceID, message string
	if err := row.Scan(&enabled, &apiKey, &deviceID, &message); err != nil {
		if err == sql.ErrNoRows {
			return map[string]any{"enabled": false, "api_key": "", "device_id": "", "message": ""}, nil
		}
		return nil, err
	}
	return map[string]any{
		"enabled":   enabled != 0,
		"api_key":   apiKey,
		"device_id": deviceID,
		"message":   message,
	}, nil
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
	return map[string]any{
		"settings":    settings,
		"devices":     devices,
		"voicemonkey": vm,
	}, nil
}

func normalizeMAC(v string) string {
	s := strings.ToLower(strings.TrimSpace(v))
	s = strings.ReplaceAll(s, "-", ":")
	s = strings.ReplaceAll(s, ".", ":")
	return s
}

func writeConfig(payload map[string]any) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if settings, ok := payload["settings"].(map[string]any); ok {
		for k, v := range settings {
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
		apiKey, _ := vm["api_key"].(string)
		deviceID, _ := vm["device_id"].(string)
		message, _ := vm["message"].(string)
		if _, err := tx.Exec(
			"INSERT INTO voicemonkey(id, enabled, api_key, device_id, message) VALUES(1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, api_key = excluded.api_key, device_id = excluded.device_id, message = excluded.message",
			enabled, strings.TrimSpace(apiKey), strings.TrimSpace(deviceID), message,
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

func jsonOK(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

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
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if err := writeConfig(payload); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		out, _ := configPayload()
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
	jsonOK(w, map[string]any{"anyone_home": anyone, "devices": devices})
}

func handleTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var payload map[string]any
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	apiKey, _ := payload["api_key"].(string)
	deviceID, _ := payload["device_id"].(string)
	speech, _ := payload["message"].(string)
	if apiKey == "" || deviceID == "" {
		writeErr(w, http.StatusBadRequest, "api_key and device_id are required")
		return
	}
	if speech == "" {
		speech = "Hola, prueba de presencia"
	}
	if err := announceVoiceMonkey(strings.TrimSpace(apiKey), strings.TrimSpace(deviceID), speech); err != nil {
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

func spaHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		clean := filepath.Clean(r.URL.Path)
		file := filepath.Join(webDir, clean)
		if info, err := os.Stat(file); err == nil && !info.IsDir() {
			http.ServeFile(w, r, file)
			return
		}
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
	mux.HandleFunc("/api/config", handleConfig)
	mux.HandleFunc("/api/presence", handlePresence)
	mux.HandleFunc("/api/voicemonkey/test", handleTest)
	mux.HandleFunc("/api/log", handleLog)
	mux.Handle("/", spaHandler())

	log.Printf("settings server listening on 0.0.0.0:%s (db=%s web=%s)", port, dbPath, webDir)
	if err := http.ListenAndServe("0.0.0.0:"+port, mux); err != nil {
		log.Fatal(err)
	}
}