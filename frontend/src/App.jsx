import React, { useEffect, useState } from 'react'

const EMPTY = {
  settings: {},
  devices: [],
  voicemonkey: { enabled: false, api_key: '', device_id: '', message: '' }
}

const HELP = {
  vm_enabled: {
    title: 'Activar anuncios de VoiceMonkey',
    body: (
      <>
        <p>
          Activa o desactiva el envío de anuncios de voz a tu Alexa. Cuando está apagado, el job de
          presencia sigue funcionando (webhooks y detección), pero no se envía ningún anuncio a
          VoiceMonkey.
        </p>
        <p>
          Necesitas una cuenta de VoiceMonkey, un <strong>Speaker device</strong> vinculado a tu Echo
          y un <strong>API token</strong> para que el anuncio funcione. El botón{' '}
          <em>Enviar anuncio de prueba</em> sirve para verificar que todo está bien configurado sin
          esperar a llegar a casa.
        </p>
      </>
    )
  },
  vm_api_key: {
    title: 'API Key (token) de VoiceMonkey',
    body: (
      <>
        <p>
          Es tu token de API de VoiceMonkey. Se parece a una cadena larga de caracteres y actúa como
          contraseña para tu cuenta: identifica que las peticiones vienen de ti.
        </p>
        <p><strong>¿Dónde lo encuentro?</strong></p>
        <ul>
          <li>Entra en <code>https://app.voicemonkey.io</code> con tu cuenta de Amazon.</li>
          <li>Abre la sección <strong>Tokens</strong> / API Credentials.</li>
          <li>Copia el token (o crea uno nuevo).</li>
        </ul>
        <p>
          Trátalo como una contraseña: no lo compartas ni lo subas a GitHub. Si crees que se filtró,
          rota el token desde la misma página y actualízalo aquí.
        </p>
      </>
    )
  },
  vm_device_id: {
    title: 'Device ID de VoiceMonkey',
    body: (
      <>
        <p>
          Es el identificador del dispositivo <strong>Speaker</strong> de VoiceMonkey, es decir, el
          Echo concreto en el que Alexa hablará.
        </p>
        <p><strong>¿Cómo lo creo / encuentro?</strong></p>
        <ul>
          <li>En <code>https://app.voicemonkey.io</code> ve a <strong>Add a device</strong>.</li>
          <li>Elige el tipo <strong>Speaker</strong> y vincúlalo al Echo que quieras.</li>
          <li>
            Copia el <strong>device ID</strong> que se muestra en la tarjeta del dispositivo (una
            cadena tipo <code>dev_xxxxxxxxxxxx</code>).
          </li>
        </ul>
        <p>
          Este es el dispositivo donde sonará el anuncio, no la MAC de tu teléfono. Si tienes varios
          Echo, crea un Speaker por cada uno.
        </p>
      </>
    )
  },
  vm_message: {
    title: 'Mensaje del anuncio',
    body: (
      <>
        <p>
          El texto que Alexa leerá en voz alta cuando alguien llegue a casa.
        </p>
        <p>
          Puedes incluir el marcador <code>{'{device_name}'}</code> y será reemplazado por el nombre
          del dispositivo que disparó el evento. Por ejemplo:
        </p>
        <pre>{'{device_name} ha llegado a casa'}</pre>
        <p>Alexa dirá: «Iphone de Paulo ha llegado a casa».</p>
        <p>
          Si no incluyes <code>{'{device_name}'}</code>, Alexa dirá el texto literal tal cual.
        </p>
      </>
    )
  },
  device_name: {
    title: 'Nombre del dispositivo',
    body: (
      <>
        <p>
          Un nombre libre para identificar el dispositivo, solo se usa para mostrarlo en la UI, en el
          webhook y en los anuncios de VoiceMonkey (si usas <code>{'{device_name}'}</code>).
        </p>
        <p>Ejemplos: «Iphone de Paulo», «MacBook de María», «Chromecast salón».</p>
        <p>No tiene que coincidir con el nombre que le puso el router.</p>
      </>
    )
  },
  device_mac: {
    title: 'Dirección MAC',
    body: (
      <>
        <p>
          Es la dirección física de la tarjeta de red del dispositivo. El job de presencia la busca
          en la red local para saber si el dispositivo está conectado (online).
        </p>
        <p><strong>¿Cómo encuentro la MAC?</strong></p>
        <ul>
          <li>
            <strong>iPhone/iPad:</strong> <code>Ajustes &gt; Wi-Fi &gt; (i) junto a tu red &gt;
            Dirección Wi-Fi</code>. Esta es la que ve la red.
          </li>
          <li>
            <strong>Android:</strong> <code>Ajustes &gt; Acerca del teléfono &gt; Estado</code> o en
            los detalles de la red Wi-Fi.
          </li>
          <li>
            <strong>Alternativa:</strong> mira la lista de clientes DHCP de tu router y copia la MAC
            del dispositivo.
          </li>
        </ul>
        <p>
          Cuidado con la <strong>Dirección Wi-Fi privada</strong> de iOS 14+: el dispositivo puede
          cambiar de MAC cada cierto tiempo y dejar de detectarse. En iOS 18 puedes fijarla a{' '}
          <strong>Fija</strong> o <strong>Desactivada</strong> para tu red de casa.
        </p>
      </>
    )
  },
  webhook_url: {
    title: 'Webhook URL',
    body: (
      <>
        <p>
          URL a la que se le envía un <code>POST</code> con JSON cada vez que un dispositivo cambia de
          estado. Es la forma de avisar a otros sistemas (Node-RED, Home Assistant, IFTTT, tu propio
          servidor…).
        </p>
        <p><strong>Cuándo se dispara:</strong></p>
        <ul>
          <li><code>device_present</code> → un dispositivo aparece en la red.</li>
          <li><code>device_away</code> → un dispositivo desaparece (tras el tiempo de Grace).</li>
          <li><code>anyone_home</code> → el primero de tus dispositivos llega.</li>
          <li><code>anyone_away</code> → todos tus dispositivos se han ido.</li>
        </ul>
        <p>
          Déjala <strong>vacía</strong> para no enviar nada. El esquema exacto del payload está en el
          apartado «Ver schema del payload».
        </p>
      </>
    )
  },
  grace: {
    title: 'Grace (segundos)',
    body: (
      <>
        <p>
          Cuántos segundos puede pasar un dispositivo sin aparecer en el escaneo antes de marcarse
          como <strong>offline</strong>.
        </p>
        <p>
          Evita falsos negativos: muchos móviles entran en «modo reposo» y dejan de responder al ping
          durante unos minutos. Sin este margen, el sistema marcaría «fuera» a un teléfono que sigue
          en casa pero dormido.
        </p>
        <p>
          <strong>Con 180s:</strong> si el dispositivo no se ve en 3 escaneos seguidos (el job corre
          cada minuto), se marca offline. Reduce el valor si quieres detectar salidas más rápido, o
          súbelo si tienes apagones frecuentes de Wi-Fi.
        </p>
      </>
    )
  },
  scan_prefix: {
    title: 'Scan prefix (tamaño de subred)',
    body: (
      <>
        <p>
          Limita cuántas direcciones IP escanea el job por cada interfaz de red. Es el prefijo de
          red (máscara) expresado en notación CIDR.
        </p>
        <p>Ejemplos:</p>
        <ul>
          <li><code>/24</code> → 254 direcciones (red típica de casa, 192.168.1.0/24).</li>
          <li><code>/23</code> → 510 direcciones.</li>
          <li><code>/16</code> → 65.534 direcciones, escanear esto cada minuto sería muy lento.</li>
        </ul>
        <p>
          Si tu router tiene una subred enorme (p. ej. <code>/16</code>), este valor recorta el
          escaneo a las primeras 254 IPs para que sea rápido. Déjalo en <strong>24</strong> salvo que
          tus dispositivos estén fuera de ese rango.
        </p>
      </>
    )
  },
  ifaces: {
    title: 'Interfaces de red (IFACES)',
    body: (
      <>
        <p>
          Especifica <strong>qué tarjetas de red</strong> del iHost se escanean. Déjalo{' '}
          <strong>vacío</strong> para que el job detecte automáticamente todas las interfaces de red
          reales (y ignore docker, veth, lo, etc.).
        </p>
        <p><strong>¿Por qué lo necesitaría?</strong></p>
        <p>
          Si el iHost tiene varias interfaces (Wi-Fi + Ethernet) y solo quieres escanear una, o si la
          auto-detección escanea una interfaz que no te interesa y ralentiza el job.
        </p>
        <p><strong>Cómo saber el nombre de tu interfaz:</strong></p>
        <pre>{`ip -o -4 addr show scope global`}</pre>
        <p>
          La primera columna de la salida es el nombre (p. ej. <code>eth0</code>, <code>wlan0</code>,
          <code>br-lan</code>). Separa varios nombres con coma:
        </p>
        <pre>eth0,wlan0</pre>
        <p>Ejemplos:</p>
        <ul>
          <li>Vacío → auto (recomendado).</li>
          <li><code>eth0</code> → solo Ethernet.</li>
          <li><code>wlan0</code> → solo Wi-Fi.</li>
          <li><code>eth0,wlan0</code> → ambas.</li>
        </ul>
      </>
    )
  }
}

function HelpButton({ help, onOpen }) {
  return (
    <button
      type="button"
      className="help-btn"
      title="Más información"
      aria-label={`Ayuda: ${help.title}`}
      onClick={(e) => {
        e.preventDefault()
        onOpen(help)
      }}
    >
      ?
    </button>
  )
}

function HelpModal({ help, onClose }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!help) return null
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{help.title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Cerrar">×</button>
        </div>
        <div className="modal-body">{help.body}</div>
      </div>
    </div>
  )
}

function Field({ label, value, onChange, type = 'text', placeholder, hint, disabled, help, onHelp }) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {help && <HelpButton help={help} onOpen={onHelp} />}
      </span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <small>{hint}</small>}
    </label>
  )
}

export default function App() {
  const [cfg, setCfg] = useState(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState('')
  const [presence, setPresence] = useState(null)
  const [help, setHelp] = useState(null)

  useEffect(() => {
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((data) => {
        setCfg({ ...EMPTY, ...data, voicemonkey: { ...EMPTY.voicemonkey, ...data.voicemonkey } })
        setLoaded(true)
      })
      .catch((e) => setError('No se pudo cargar la configuración: ' + e.message))
  }, [])

  useEffect(() => {
    fetch('/api/presence')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then(setPresence)
      .catch(() => setPresence(null))
  }, [loaded])

  function setSetting(key, value) {
    setCfg((c) => ({ ...c, settings: { ...c.settings, [key]: value } }))
  }

  function setVM(key, value) {
    setCfg((c) => ({ ...c, voicemonkey: { ...c.voicemonkey, [key]: value } }))
  }

  function setDevice(i, key, value) {
    setCfg((c) => {
      const devices = c.devices.map((d, idx) => (idx === i ? { ...d, [key]: value } : d))
      return { ...c, devices }
    })
  }

  function addDevice() {
    setCfg((c) => ({ ...c, devices: [...c.devices, { name: '', mac: '' }] }))
  }

  function removeDevice(i) {
    setCfg((c) => ({ ...c, devices: c.devices.filter((_, idx) => idx !== i) }))
  }

  async function save() {
    setError('')
    setSaved(false)
    setSaving(true)
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg)
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'HTTP ' + res.status)
      }
      const data = await res.json()
      setCfg({ ...EMPTY, ...data, voicemonkey: { ...EMPTY.voicemonkey, ...data.voicemonkey } })
      setSaved(true)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function testVoiceMonkey() {
    setError('')
    setTestMsg('')
    setTesting(true)
    try {
      const res = await fetch('/api/voicemonkey/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg.voicemonkey)
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'HTTP ' + res.status)
      }
      setTestMsg('Anuncio enviado correctamente a Alexa.')
    } catch (e) {
      setError('Fallo al enviar anuncio: ' + e.message)
    } finally {
      setTesting(false)
    }
  }

  return (
    <main className="page">
      <header>
        <h1>Presence iHost</h1>
        <p className="subtitle">Configuración del job de presencia y anuncios a Alexa (cada minuto)</p>
      </header>

      {!loaded && !error && <p>Cargando…</p>}
      {error && <div className="banner error">{error}</div>}
      {saved && <div className="banner ok">Configuración guardada correctamente.</div>}

      {loaded && (
        <>
          <section className="card">
            <h2>
              VoiceMonkey (Alexa)
              <HelpButton help={HELP.vm_enabled} onOpen={setHelp} />
            </h2>
            <p className="desc">
              Cuando alguien llegue a casa se enviará un anuncio con el nombre del dispositivo a tu Alexa.
              El mensaje puede incluir <code>{'{device_name}'}</code> para insertar el nombre del dispositivo.
            </p>
            <div className="grid">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={cfg.voicemonkey.enabled}
                  onChange={(e) => setVM('enabled', e.target.checked)}
                />
                <span>Activar anuncios</span>
                <HelpButton help={HELP.vm_enabled} onOpen={setHelp} />
              </label>
            </div>
            <div className="grid">
              <Field label="API Key (token)" value={cfg.voicemonkey.api_key} onChange={(v) => setVM('api_key', v)} placeholder="Pega tu token de VoiceMonkey aquí" help={HELP.vm_api_key} onHelp={setHelp} />
              <Field label="Device ID" value={cfg.voicemonkey.device_id} onChange={(v) => setVM('device_id', v)} placeholder="P. ej. dev_8f3k2m9x" help={HELP.vm_device_id} onHelp={setHelp} />
            </div>
            <Field
              label="Mensaje"
              value={cfg.voicemonkey.message}
              onChange={(v) => setVM('message', v)}
              placeholder={'{device_name} ha llegado a casa'}
              help={HELP.vm_message}
              onHelp={setHelp}
            />
            <button className="btn ghost" onClick={testVoiceMonkey} disabled={testing}>
              {testing ? 'Enviando…' : 'Enviar anuncio de prueba'}
            </button>
            {testMsg && <p className="ok-text">{testMsg}</p>}
          </section>

          <section className="card">
            <h2>Dispositivos</h2>
            <p className="desc">Dispositivos a vigilar en la red local. Nombre y dirección MAC.</p>
            {cfg.devices.length === 0 && <p className="muted">No hay dispositivos configurados.</p>}
            {cfg.devices.map((d, i) => (
              <div className="device-row" key={i}>
                <Field label="Nombre" value={d.name} onChange={(v) => setDevice(i, 'name', v)} placeholder="Iphone de Paulo" help={HELP.device_name} onHelp={setHelp} />
                <Field label="MAC" value={d.mac} onChange={(v) => setDevice(i, 'mac', v)} placeholder="00:11:22:33:44:55" help={HELP.device_mac} onHelp={setHelp} />
                <button className="btn danger" onClick={() => removeDevice(i)}>Quitar</button>
              </div>
            ))}
            <button className="btn ghost" onClick={addDevice}>+ Añadir dispositivo</button>
          </section>

          {presence && (
            <section className="card">
              <h2>Estado actual</h2>
              <p className="desc">
                Alguien en casa:{' '}
                <span className={presence.anyone_home ? 'pill online' : 'pill offline'}>
                  {presence.anyone_home ? 'Sí' : 'No'}
                </span>
              </p>
              {presence.devices.map((d) => (
                <div className="presence-row" key={d.mac}>
                  <span className="status-dot" data-status={d.present ? 'online' : 'offline'}></span>
                  <span className="pname">{d.name}</span>
                  <span className="pmac">{d.mac}</span>
                  <span className={d.present ? 'pill online' : 'pill offline'}>
                    {d.present ? 'online' : 'offline'}
                  </span>
                  {d.ip && <span className="pip">{d.ip}</span>}
                </div>
              ))}
            </section>
          )}

          <section className="card">
            <h2>Webhook</h2>
            <p className="desc">
              URL que recibe un <code>POST</code> JSON cuando un dispositivo pasa a{' '}
              <strong>online</strong> u <strong>offline</strong>. Déjala vacía para no enviar nada.
            </p>
            <Field
              label="Webhook URL"
              value={cfg.settings.webhook_url || ''}
              onChange={(v) => setSetting('webhook_url', v)}
              placeholder="https://hooks.ejemplo.com/presencia"
              help={HELP.webhook_url}
              onHelp={setHelp}
            />
            <details className="schema">
              <summary>Ver schema del payload</summary>
              <pre>{JSON.stringify({
                event: 'device_present',
                ts: '2026-09-19T10:00:00+00:00',
                device_name: 'Iphone de Paulo',
                mac: '00:11:22:33:44:55',
                ip: '192.168.1.100',
                status: 'online'
              }, null, 2)}</pre>
              <p>
                <code>event</code>: <code>device_present</code> | <code>device_away</code> |{' '}
                <code>anyone_home</code> | <code>anyone_away</code>. En <code>anyone_*</code> no se
                incluyen <code>device_name</code>/<code>mac</code>/<code>ip</code>.
              </p>
            </details>
          </section>

          <section className="card">
            <h2>Escaneo</h2>
            <p className="desc">
              El escaneo se ejecuta como un job cada 1 minuto (cron). Aquí solo se ajusta la
              tolerancia y las interfaces.
            </p>
            <div className="grid">
              <Field label="Grace (s)" type="number" value={cfg.settings.grace || '180'} onChange={(v) => setSetting('grace', v)} hint="Segundos sin verse antes de marcarse offline" help={HELP.grace} onHelp={setHelp} />
              <Field label="Scan prefix" type="number" value={cfg.settings.scan_prefix || '24'} onChange={(v) => setSetting('scan_prefix', v)} hint="Tamaño máximo de subred a escanear" help={HELP.scan_prefix} onHelp={setHelp} />
            </div>
            <Field label="Interfaces (IFACES)" value={cfg.settings.ifaces || ''} onChange={(v) => setSetting('ifaces', v)} placeholder="Déjalo vacío (auto) o p. ej. eth0,wlan0" hint="Separadas por coma. Vacío = auto-detección" help={HELP.ifaces} onHelp={setHelp} />
          </section>

          <div className="actions">
            <button className="btn primary" onClick={save} disabled={saving}>
              {saving ? (
                <>
                  <span className="spinner" aria-hidden="true"></span> Guardando…
                </>
              ) : (
                'Guardar configuración'
              )}
            </button>
          </div>
        </>
      )}

      <HelpModal help={help} onClose={() => setHelp(null)} />
    </main>
  )
}