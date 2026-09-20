import React, { useEffect, useState } from 'react'

const EMPTY = {
  settings: {},
  devices: [],
  voicemonkey: { enabled: false, api_key: '', api_key_masked: '', api_key_set: false, device_id: '', message: '', voice: '', language: '', chime: '', website_url: '' }
}

const btnBase =
  'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950'
const btnPrimary = `${btnBase} bg-sky-400 text-slate-950 font-semibold hover:bg-sky-300`
const btnGhost = `${btnBase} border border-slate-600 text-slate-200 hover:bg-slate-800`
const btnDanger = `${btnBase} border border-red-800 text-red-400 hover:bg-red-950/40`
const btnSmall = 'px-2.5 py-1 text-xs'
const inputCls =
  'w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-400/60 focus:border-sky-400 disabled:opacity-50'
const cardCls = 'bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-5 shadow-lg shadow-black/10'
const h2Cls = 'text-lg font-semibold text-slate-100 mb-1.5'
const descCls = 'text-sm text-slate-400 mb-4'
const fieldLabelCls = 'flex items-center gap-1.5 text-sm font-medium text-slate-300'
const hintCls = 'text-xs text-slate-400'
const errorCls = 'text-xs text-red-300'
const warningCls = 'text-xs text-amber-300'
const spinner = 'inline-block w-3.5 h-3.5 rounded-full border-2 border-slate-950/30 border-t-slate-950 animate-spin align-[-2px] mr-1.5'
const spinnerLight = 'inline-block w-3.5 h-3.5 rounded-full border-2 border-slate-300/40 border-t-slate-300 animate-spin align-[-2px] mr-1.5'
const pillCls = (on) =>
  `inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${on ? 'bg-emerald-900 text-emerald-200' : 'bg-red-900/70 text-red-200'}`

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
        <p>
          El token guardado nunca se muestra completo: solo se muestra enmascarado. Para reemplazarlo
          pulsa <em>Cambiar token</em>.
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
  notify_cooldown: {
    title: 'Cooldown notificación (segundos)',
    body: (
      <>
        <p>
          Tiempo mínimo que debe pasar entre dos anuncios de «alguien llegó a casa» (
          <code>anyone_home</code>).
        </p>
        <p>
          Si tu móvil se duerme, se desconecta o pierde señal al llegar y vuelve a aparecer unos
          minutos después, sin este margen recibirías el saludo de bienvenida <strong>dos veces</strong>{' '}
          (una al llegar y otra al «reconectarse»).
        </p>
        <p>
          <strong>Con 1800s (30 min):</strong> si vuelves a «aparecer» antes de 30 minutos de la última
          bienvenida, no se reenvía el anuncio. No afecta al resto de eventos (<code>device_present</code>,
          <code>device_away</code>, <code>anyone_away</code>), que siguen notificándose siempre.
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

function validate(cfg, edited) {
  const errors = {}
  const warnings = {}
  const settings = cfg.settings || {}
  const devices = cfg.devices || []
  const vm = cfg.voicemonkey || {}

  const grace = parseInt(settings.grace, 10)
  if (Number.isNaN(grace) || grace < 10 || grace > 3600) {
    errors.grace = 'Debe estar entre 10 y 3600 segundos'
  }
  const nc = parseInt(settings.notify_cooldown, 10)
  if (Number.isNaN(nc) || nc < 10 || nc > 86400) {
    errors.notify_cooldown = 'Debe estar entre 10 y 86400 segundos'
  }
  const sp = parseInt(settings.scan_prefix, 10)
  if (Number.isNaN(sp) || sp < 16 || sp > 30) {
    errors.scan_prefix = 'Debe estar entre 16 y 30'
  }
  if (settings.ifaces) {
    const tokens = settings.ifaces.split(',')
    for (const t of tokens) {
      if (t.trim() && !/^[a-zA-Z0-9._-]+$/.test(t.trim())) {
        errors.ifaces = 'Nombre de interfaz inválido'
        break
      }
    }
  }

  const ac = parseInt(settings.away_confirmations, 10)
  if (Number.isNaN(ac) || ac < 1 || ac > 20) {
    errors.away_confirmations = 'Debe estar entre 1 y 20'
  }
  const dc = parseInt(settings.device_notify_cooldown, 10)
  if (Number.isNaN(dc) || dc < 0 || dc > 86400) {
    errors.device_notify_cooldown = 'Debe estar entre 0 y 86400 segundos'
  }
  for (const k of ['passive_sniff_enabled', 'use_nmap']) {
    const v = String(settings[k] ?? '').toLowerCase()
    if (v !== '' && v !== 'true' && v !== 'false' && v !== '1' && v !== '0') {
      errors[k] = 'Debe ser true o false'
    }
  }
  if (settings.passive_sniff_ifaces) {
    const tokens = settings.passive_sniff_ifaces.split(',')
    for (const t of tokens) {
      if (t.trim() && !/^[a-zA-Z0-9._-]+$/.test(t.trim())) {
        errors.passive_sniff_ifaces = 'Nombre de interfaz inválido'
        break
      }
    }
  }
  if (settings.nmap_bin && String(settings.nmap_bin).trim() === '') {
    errors.nmap_bin = 'Ruta al binario inválida'
  }

  const wh = (settings.webhook_url || '').trim()
  if (wh) {
    let parsed = null
    try {
      parsed = new URL(wh)
    } catch (e) {
      parsed = null
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
      errors.webhook_url = 'URL inválida'
    } else if (parsed.protocol === 'http:') {
      const host = parsed.hostname
      const lanHost = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost' || host.endsWith('.local') || host.endsWith('.lan')
      if (!lanHost) errors.webhook_url = 'URL no segura: usa https://'
      else warnings.webhook_url = 'Usando http:// sin cifrar en tu LAN'
    }
  }

  const seen = {}
  devices.forEach((d, i) => {
    const key = `devices[${i}]`
    const name = (d.name || '').trim()
    if (!name) errors[`${key}.name`] = 'El nombre no puede estar vacío'
    else if (name.length > 64) errors[`${key}.name`] = 'Máximo 64 caracteres'
    else if (/[\x00-\x1f\x7f]/.test(name)) errors[`${key}.name`] = 'El nombre contiene caracteres no válidos'
    const macRaw = (d.mac || '').trim()
    const mac = macRaw.toLowerCase().replace(/-/g, ':').replace(/\./g, ':')
    if (!macRaw) errors[`${key}.mac`] = 'La MAC no puede estar vacía'
    else if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) errors[`${key}.mac`] = 'MAC inválida. Formato: aa:bb:cc:dd:ee:ff'
    else if (seen[mac]) errors[`${key}.mac`] = 'Ya existe un dispositivo con esta MAC'
    else seen[mac] = true
  })

  if (vm.enabled) {
    const hasKey = edited ? (vm.api_key || '').trim() : !!vm.api_key_set
    if (!hasKey) errors['voicemonkey.api_key'] = 'Requerido si los anuncios están activos'
    if (!(vm.device_id || '').trim()) errors['voicemonkey.device_id'] = 'Requerido si los anuncios están activos'
  }

  const msg = vm.message || ''
  const m = msg.match(/\{device_[^}]*\}/g)
  if (m && m.some((x) => x !== '{device_name}')) {
    warnings['voicemonkey.message'] = '¿Quisiste decir `{device_name}`?'
  }

  const wu = (vm.website_url || '').trim()
  if (wu) {
    try {
      const u = new URL(wu)
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) {
        errors['voicemonkey.website_url'] = 'URL inválida'
      }
    } catch (e) {
      errors['voicemonkey.website_url'] = 'URL inválida'
    }
  }

  return { errors, warnings }
}

function fieldId(key) {
  return 'field-' + key.replace(/\[/g, '-').replace(/\]/g, '').replace(/\./g, '-')
}

function focusField(key) {
  const el = document.getElementById(fieldId(key))
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.focus({ preventScroll: true })
  }
}

function HelpButton({ help, onOpen }) {
  return (
    <button
      type="button"
      title="Más información"
      aria-label={`Ayuda: ${help.title}`}
      aria-haspopup="dialog"
      className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full border border-slate-500 text-slate-400 text-xs font-bold leading-none hover:bg-sky-400 hover:border-sky-400 hover:text-sky-950 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
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
    <div className="fixed inset-0 bg-slate-950/70 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="bg-slate-900 border border-slate-700 rounded-2xl max-w-lg w-full max-h-[82vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-slate-900 border-b border-slate-700 px-5 py-4 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-100">{help.title}</h3>
          <button onClick={onClose} aria-label="Cerrar" className="text-slate-400 text-2xl leading-none hover:text-slate-100">×</button>
        </div>
        <div className="px-5 py-4 text-sm text-slate-300 leading-relaxed [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:pl-5 [&_li]:mb-1.5 [&_pre]:bg-slate-950 [&_pre]:rounded-md [&_pre]:px-3 [&_pre]:py-2 [&_pre]:overflow-x-auto [&_pre]:text-xs [&_pre]:mb-3">
          {help.body}
        </div>
      </div>
    </div>
  )
}

const bannerKinds = {
  ok: 'bg-emerald-900/70 border-emerald-700 text-emerald-100',
  warn: 'bg-amber-900/70 border-amber-700 text-amber-100',
  error: 'bg-red-900/70 border-red-800 text-red-200'
}

function Banner({ kind, onClose, children }) {
  useEffect(() => {
    if (kind !== 'ok') return
    const t = setTimeout(onClose, 4000)
    return () => clearTimeout(t)
  }, [kind, onClose])
  return (
    <div
      role={kind === 'ok' ? 'status' : 'alert'}
      className={`flex items-start justify-between gap-3 rounded-lg border px-4 py-3 mb-4 ${bannerKinds[kind]}`}
    >
      <div className="flex-1 text-sm [&_ul]:mt-2 [&_ul]:pl-5 [&_li]:text-xs [&_li]:mb-0.5">{children}</div>
      <button onClick={onClose} aria-label="Cerrar aviso" className="shrink-0 text-lg leading-none opacity-80 hover:opacity-100">×</button>
    </div>
  )
}

function Switch({ checked, onChange, label, help, onHelp }) {
  return (
    <label className="inline-flex items-center gap-2.5 cursor-pointer select-none">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden="true"
        className="relative inline-flex w-11 h-6 rounded-full bg-slate-600 transition-colors peer-checked:bg-sky-400 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-5 after:h-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5 peer-focus-visible:ring-2 peer-focus-visible:ring-sky-400 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-slate-950"
      />
      <span className="text-sm text-slate-200">{label}</span>
      {help && <HelpButton help={help} onOpen={onHelp} />}
    </label>
  )
}

function Field({ id, label, value, onChange, type = 'text', placeholder, hint, disabled, help, onHelp, error, warning, autoComplete }) {
  const described = []
  if (error) described.push(`${id}-error`)
  if (hint) described.push(`${id}-hint`)
  return (
    <label className="flex flex-col gap-1.5 flex-1 min-w-0" htmlFor={id}>
      <span className={fieldLabelCls}>
        {label}
        {help && <HelpButton help={help} onOpen={onHelp} />}
      </span>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete={autoComplete}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={described.length ? described.join(' ') : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={inputCls}
      />
      {error && <small id={`${id}-error`} className={errorCls} role="alert">{error}</small>}
      {warning && !error && <small className={warningCls} role="status">⚠ {warning}</small>}
      {hint && !error && !warning && <small id={`${id}-hint`} className={hintCls}>{hint}</small>}
    </label>
  )
}

function VMKeyField({ vm, edited, visible, onStartEdit, onToggleVisible, onChange, error }) {
  const id = fieldId('voicemonkey.api_key')
  const hasStored = !!vm.api_key_set
  const value = edited ? vm.api_key : (vm.api_key_masked || '')
  return (
    <div className="flex flex-col gap-1.5 flex-1 min-w-0">
      <span className={fieldLabelCls}>API Key (token)</span>
      <div className="flex gap-2 items-center">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          placeholder={hasStored && !edited ? vm.api_key_masked : 'Pega tu token de VoiceMonkey aquí'}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => {
            if (!edited) onStartEdit()
            onChange(e.target.value)
          }}
          onFocus={() => {
            if (!edited) onStartEdit()
          }}
          autoComplete="off"
          className={`${inputCls} flex-1`}
        />
        <button
          type="button"
          onClick={onToggleVisible}
          disabled={!edited}
          aria-disabled={!edited}
          title={edited ? (visible ? 'Ocultar token' : 'Revelar token temporalmente') : 'Solo se puede revelar al escribir un token nuevo'}
          className={`${btnGhost} ${btnSmall} shrink-0`}
        >
          {visible ? 'Ocultar' : 'Mostrar'}
        </button>
        {!edited && hasStored && (
          <button type="button" className={`${btnGhost} ${btnSmall} shrink-0`} onClick={() => { onChange(''); onStartEdit() }}>
            Cambiar token
          </button>
        )}
      </div>
      {!edited && hasStored && <small className={hintCls}>Token guardado y oculto. Para reemplazarlo pulsa «Cambiar token».</small>}
      {error && <small id={`${id}-error`} className={errorCls} role="alert">{error}</small>}
    </div>
  )
}

export default function App() {
  const [cfg, setCfg] = useState(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [authReady, setAuthReady] = useState(false)
  const [authState, setAuthState] = useState({ configured: false, skipped: false })
  const [setup, setSetup] = useState({ username: '', password: '', error: '', busy: false })

  const [saveState, setSaveState] = useState('idle')
  const [saveErrors, setSaveErrors] = useState({})
  const [saveMsg, setSaveMsg] = useState('')

  const [vmKeyEdited, setVmKeyEdited] = useState(false)
  const [vmKeyVisible, setVmKeyVisible] = useState(false)

  const [testState, setTestState] = useState('idle')
  const [testMsg, setTestMsg] = useState('')

  const [whTest, setWhTest] = useState({ state: 'idle', msg: '' })

  const [presence, setPresence] = useState(null)
  const [help, setHelp] = useState(null)
  const [logs, setLogs] = useState(null)
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsAuto, setLogsAuto] = useState(false)

  const showWizard = authReady && !authState.configured && !authState.skipped
  const { errors: liveErrors, warnings: liveWarnings } = validate(cfg, vmKeyEdited)
  const canEdit = authState.configured || authState.skipped

  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => (r.ok ? r.json() : {}))
      .then((s) => {
        setAuthState({ configured: !!s.configured, skipped: !!s.skipped })
        setAuthReady(true)
      })
      .catch(() => setAuthReady(true))
  }, [])

  function loadConfig() {
    setLoading(true)
    setLoadError('')
    fetch('/api/config')
      .then(async (r) => {
        if (r.status === 401) throw new Error('AUTH_REQUIRED')
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then((data) => {
        setCfg({ ...EMPTY, ...data, voicemonkey: { ...EMPTY.voicemonkey, ...data.voicemonkey } })
        setLoaded(true)
        setLoading(false)
      })
      .catch((e) => {
        setLoading(false)
        setLoadError(
          e.message === 'AUTH_REQUIRED'
            ? 'Acceso denegado. Recarga la página e inicia sesión con las credenciales configuradas.'
            : 'No se pudo cargar la configuración: ' + e.message
        )
      })
  }

  useEffect(() => {
    if (!authReady || !canEdit) return
    loadConfig()
  }, [authReady, canEdit])

  function loadPresence() {
    fetch('/api/presence')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then(setPresence)
      .catch(() => setPresence(null))
  }

  useEffect(() => {
    if (!loaded) return
    loadPresence()
    const t = setInterval(loadPresence, 10000)
    return () => clearInterval(t)
  }, [loaded])

  useEffect(() => {
    if (!logsAuto) return
    const t = setInterval(() => loadLogs(), 10000)
    return () => clearInterval(t)
  }, [logsAuto])

  function setSetting(key, value) {
    setCfg((c) => ({ ...c, settings: { ...c.settings, [key]: value } }))
  }

  function setBoolSetting(key, value) {
    setSetting(key, value ? 'true' : 'false')
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

  function loadLogs() {
    setLogsLoading(true)
    fetch('/api/log')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then(setLogs)
      .catch(() => setLogs(null))
      .finally(() => setLogsLoading(false))
  }

  function buildPayload() {
    return {
      ...cfg,
      voicemonkey: { ...cfg.voicemonkey, api_key: vmKeyEdited ? cfg.voicemonkey.api_key : '' }
    }
  }

  async function save() {
    const { errors } = validate(cfg, vmKeyEdited)
    if (Object.keys(errors).length > 0) {
      setSaveErrors(errors)
      setSaveState('validation')
      focusField(Object.keys(errors)[0])
      return
    }
    setSaveErrors({})
    setSaveState('saving')
    setSaveMsg('')
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify(buildPayload())
      })
      if (res.status === 400) {
        const data = await res.json().catch(() => ({}))
        const errs = data.errors || {}
        setSaveErrors(errs)
        setSaveState('validation')
        focusField(Object.keys(errs)[0] || 'grace')
        return
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setSaveMsg(data.error || 'HTTP ' + res.status)
        setSaveState('error')
        return
      }
      const data = await res.json()
      setCfg({ ...EMPTY, ...data, voicemonkey: { ...EMPTY.voicemonkey, ...data.voicemonkey } })
      setVmKeyEdited(false)
      setVmKeyVisible(false)
      setSaveState('ok')
    } catch (e) {
      setSaveMsg(e.message)
      setSaveState('error')
    }
  }

  async function testVoiceMonkey() {
    setTestState('sending')
    setTestMsg('')
    try {
      const res = await fetch('/api/voicemonkey/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({
          api_key: vmKeyEdited ? cfg.voicemonkey.api_key : '',
          device_id: cfg.voicemonkey.device_id,
          message: cfg.voicemonkey.message
        })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setTestState('error')
        setTestMsg(data.error || 'HTTP ' + res.status)
        return
      }
      setTestState('ok')
      setTestMsg('Anuncio enviado correctamente a Alexa.')
    } catch (e) {
      setTestState('error')
      setTestMsg(e.message)
    }
  }

  async function testWebhook() {
    setWhTest({ state: 'sending', msg: '' })
    try {
      const res = await fetch('/api/webhook/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ url: (cfg.settings.webhook_url || '').trim() })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setWhTest({ state: 'error', msg: data.error || 'HTTP ' + res.status })
        return
      }
      setWhTest({ state: 'ok', msg: 'Evento de prueba enviado.' })
    } catch (e) {
      setWhTest({ state: 'error', msg: e.message })
    }
  }

  async function submitSetup(skip) {
    setSetup((s) => ({ ...s, busy: true, error: '' }))
    try {
      const body = skip ? { skip: true } : { username: setup.username, password: setup.password }
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify(body)
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status)
      setSetup({ username: '', password: '', error: '', busy: false })
      const st = await fetch('/api/auth/status').then((r) => r.json()).catch(() => ({}))
      setAuthState({ configured: !!st.configured, skipped: !!st.skipped })
    } catch (e) {
      setSetup((s) => ({ ...s, busy: false, error: e.message }))
    }
  }

  const vm = cfg.voicemonkey || EMPTY.voicemonkey
  const vmHasKey = vmKeyEdited ? (vm.api_key || '').trim() : !!vm.api_key_set
  const vmCanTest = vm.enabled && !!vmHasKey && !!(vm.device_id || '').trim()
  const vmTestDisabledReason = !vm.enabled
    ? 'Activa los anuncios para poder enviar una prueba.'
    : !vmHasKey
      ? 'Falta la API Key de VoiceMonkey.'
      : 'Falta el Device ID de VoiceMonkey.'

  const whUrl = (cfg.settings.webhook_url || '').trim()
  const whCanTest = whUrl !== '' && !liveErrors.webhook_url
  const whTestDisabledReason = whUrl === '' ? 'Introduce una URL de webhook primero.' : 'La URL no es válida.'

  return (
    <main className="max-w-[760px] mx-auto px-4 py-8 pb-16">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-100">Presence iHost</h1>
        <p className="text-sm text-slate-400 mt-1">Configuración del job de presencia y anuncios a Alexa (cada minuto)</p>
      </header>

      {!authReady && <p className="text-slate-400">Cargando…</p>}

      {authReady && showWizard && (
        <section className={`${cardCls} max-w-xl`}>
          <h2 className={h2Cls}>Configura tu acceso</h2>
          <p className={descCls}>
            La interfaz está expuesta en tu red local. Antes de configurar tus dispositivos y tokens,
            protege el acceso con un usuario y contraseña.
          </p>
          <div className="flex flex-col gap-3">
            <Field id="field-setup-username" label="Usuario" value={setup.username} onChange={(v) => setSetup((s) => ({ ...s, username: v }))} autoComplete="username" />
            <Field id="field-setup-password" label="Contraseña (mínimo 8 caracteres)" type="password" value={setup.password} onChange={(v) => setSetup((s) => ({ ...s, password: v }))} autoComplete="new-password" />
          </div>
          {setup.error && (
            <div className="rounded-lg border border-red-800 bg-red-900/70 text-red-200 px-4 py-3 text-sm mt-3">{setup.error}</div>
          )}
          <div className="mt-4 flex flex-wrap gap-3">
            <button className={btnPrimary} onClick={() => submitSetup(false)} disabled={setup.busy || !setup.username.trim() || setup.password.length < 8}>
              {setup.busy ? 'Creando…' : 'Crear acceso'}
            </button>
            <button className={btnGhost} onClick={() => submitSetup(true)} disabled={setup.busy}>
              Omitir por ahora, no recomendado
            </button>
          </div>
        </section>
      )}

      {authReady && !showWizard && canEdit && (
        <>
          {loadError && <Banner kind="error" onClose={() => setLoadError('')}>{loadError}</Banner>}
          {loadError && (
            <div className="mb-4">
              <button className={btnGhost} onClick={loadConfig}>Reintentar</button>
            </div>
          )}
          {loading && <p className="text-slate-400">Cargando configuración…</p>}
          {!loading && !loadError && !loaded && <p className="text-slate-400">No se pudo cargar la configuración.</p>}

          {saveState === 'ok' && (
            <Banner kind="ok" onClose={() => setSaveState('idle')}>Configuración guardada correctamente.</Banner>
          )}
          {saveState === 'validation' && Object.keys(saveErrors).length > 0 && (
            <Banner kind="warn" onClose={() => setSaveState('idle')}>
              <strong>No se pudo guardar:</strong> revisa los campos marcados en rojo.
              <ul>
                {Object.entries(saveErrors).map(([k, v]) => (
                  <li key={k}>{k}: {v}</li>
                ))}
              </ul>
            </Banner>
          )}
          {saveState === 'error' && (
            <Banner kind="error" onClose={() => setSaveState('idle')}>{saveMsg || 'No se pudo guardar la configuración.'}</Banner>
          )}

          {loaded && (
            <>
              <section className={cardCls}>
                <h2 className={h2Cls}>
                  VoiceMonkey (Alexa)
                  <HelpButton help={HELP.vm_enabled} onOpen={setHelp} />
                </h2>
                <p className={descCls}>
                  Cuando alguien llegue a casa se enviará un anuncio con el nombre del dispositivo a tu Alexa.
                  El mensaje puede incluir <code>{'{device_name}'}</code> para insertar el nombre del dispositivo.
                </p>
                <Switch
                  checked={vm.enabled}
                  onChange={(v) => setVM('enabled', v)}
                  label="Activar anuncios"
                  help={HELP.vm_enabled}
                  onHelp={setHelp}
                />
                {!vm.enabled ? (
                  <p className="text-sm text-slate-400 mt-3">Activa los anuncios para configurar VoiceMonkey.</p>
                ) : (
                  <>
                    <div className="grid gap-3 md:grid-cols-2 mt-4">
                      <VMKeyField
                        vm={vm}
                        edited={vmKeyEdited}
                        visible={vmKeyVisible}
                        onStartEdit={() => setVmKeyEdited(true)}
                        onToggleVisible={() => setVmKeyVisible((v) => !v)}
                        onChange={(v) => setVM('api_key', v)}
                        error={liveErrors['voicemonkey.api_key']}
                      />
                      <Field
                        id={fieldId('voicemonkey.device_id')}
                        label="Device ID"
                        value={vm.device_id}
                        onChange={(v) => setVM('device_id', v)}
                        placeholder="P. ej. dev_8f3k2m9x"
                        help={HELP.vm_device_id}
                        onHelp={setHelp}
                        error={liveErrors['voicemonkey.device_id']}
                      />
                    </div>
                    <div className="mt-3">
                      <Field
                        id={fieldId('voicemonkey.message')}
                        label="Mensaje"
                        value={vm.message}
                        onChange={(v) => setVM('message', v)}
                        placeholder={'{device_name} ha llegado a casa'}
                        help={HELP.vm_message}
                        onHelp={setHelp}
                        warning={liveWarnings['voicemonkey.message']}
                      />
                    </div>
                    <div className="grid gap-3 md:grid-cols-2 mt-3">
                      <Field
                        id={fieldId('voicemonkey.voice')}
                        label="Voice"
                        value={vm.voice}
                        onChange={(v) => setVM('voice', v)}
                        placeholder="Lupe"
                        hint="Amazon Polly voice (vacío = Lucia)"
                      />
                      <Field
                        id={fieldId('voicemonkey.language')}
                        label="Language"
                        value={vm.language}
                        onChange={(v) => setVM('language', v)}
                        placeholder="es-ES"
                        hint="Código BCP-47, p. ej. es-ES"
                      />
                    </div>
                    <div className="grid gap-3 md:grid-cols-2 mt-3">
                      <Field
                        id={fieldId('voicemonkey.chime')}
                        label="Chime"
                        value={vm.chime}
                        onChange={(v) => setVM('chime', v)}
                        placeholder="soundbank://soundlibrary/alarms/beeps_and_bloops/bell_02"
                        hint="Sonido previo (soundbank URL)"
                      />
                      <Field
                        id={fieldId('voicemonkey.website_url')}
                        label="Website URL (Echo Show)"
                        value={vm.website_url}
                        onChange={(v) => setVM('website_url', v)}
                        placeholder="https://www.paulomcnally.com/presence-ihost/"
                        hint="Página que se muestra en pantalla (vacío = no se envía)"
                        error={liveErrors['voicemonkey.website_url']}
                      />
                    </div>
                    <div className="mt-4 flex items-center gap-3 flex-wrap">
                      <button
                        className={btnGhost}
                        onClick={testVoiceMonkey}
                        disabled={!vmCanTest || testState === 'sending'}
                        aria-disabled={!vmCanTest}
                        title={vmCanTest ? undefined : vmTestDisabledReason}
                      >
                        {testState === 'sending' ? 'Enviando…' : 'Enviar anuncio de prueba'}
                      </button>
                      {!vmCanTest && vm.enabled && <small className={hintCls}>{vmTestDisabledReason}</small>}
                    </div>
                    {testState === 'ok' && <p className="text-emerald-400 text-sm mt-2">✅ Anuncio enviado correctamente a Alexa.</p>}
                    {testState === 'error' && <p className="text-red-400 text-sm mt-2">❌ Error: {testMsg}</p>}
                  </>
                )}
              </section>

              <section className={cardCls}>
                <h2 className={h2Cls}>Dispositivos</h2>
                <p className={descCls}>Dispositivos a vigilar en la red local. Nombre y dirección MAC.</p>
                {cfg.devices.length === 0 && (
                  <div className="border border-dashed border-slate-600 rounded-lg p-4 text-sm text-slate-400 mb-3">
                    <p>
                      Aún no has añadido dispositivos. Añade al menos uno para que el job de presencia
                      tenga algo que vigilar.
                    </p>
                  </div>
                )}
                {cfg.devices.map((d, i) => (
                  <div className="flex flex-col md:flex-row gap-3 md:items-end mb-3" key={i}>
                    <Field
                      id={fieldId(`devices[${i}].name`)}
                      label="Nombre"
                      value={d.name}
                      onChange={(v) => setDevice(i, 'name', v)}
                      placeholder="Iphone de Paulo"
                      help={HELP.device_name}
                      onHelp={setHelp}
                      error={liveErrors[`devices[${i}].name`]}
                    />
                    <Field
                      id={fieldId(`devices[${i}].mac`)}
                      label="MAC"
                      value={d.mac}
                      onChange={(v) => setDevice(i, 'mac', v)}
                      placeholder="00:11:22:33:44:55"
                      help={HELP.device_mac}
                      onHelp={setHelp}
                      error={liveErrors[`devices[${i}].mac`]}
                    />
                    <button className={`${btnDanger} md:mb-0.5 shrink-0`} onClick={() => removeDevice(i)}>Quitar</button>
                  </div>
                ))}
                <button className={`${btnGhost} ${btnSmall}`} onClick={addDevice}>+ Añadir dispositivo</button>
              </section>

              {presence && (
                <section className={cardCls}>
                  <h2 className={h2Cls}>Estado actual</h2>
                  {!presence.last_job_run ? (
                    <p className="text-sm text-slate-400">Sin datos aún: el job de presencia todavía no ha corrido.</p>
                  ) : (
                    <>
                      <p className={descCls}>Última ejecución del job: {presence.last_job_run}</p>
                      <p className={descCls}>
                        Alguien en casa:{' '}
                        <span className={pillCls(presence.anyone_home)}>
                          {presence.anyone_home ? 'Sí' : 'No'}
                        </span>
                      </p>
                      {presence.devices.map((d) => (
                        <div className="flex items-center gap-2.5 py-1.5 text-sm" key={d.mac}>
                          <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${d.present ? 'bg-emerald-400' : 'bg-slate-500'}`}></span>
                          <span className="font-semibold text-slate-200">{d.name}</span>
                          <span className="text-xs text-slate-400">{d.mac}</span>
                          <span className={pillCls(d.present)}>
                            {d.present ? 'online' : 'offline'}
                          </span>
                          {d.ip && <span className="text-xs text-slate-400 ml-auto">{d.ip}</span>}
                        </div>
                      ))}
                    </>
                  )}
                </section>
              )}

              <section className={cardCls}>
                <h2 className={h2Cls}>Webhook</h2>
                <p className={descCls}>
                  URL que recibe un <code>POST</code> JSON cuando un dispositivo pasa a{' '}
                  <strong>online</strong> u <strong>offline</strong>. Déjala vacía para no enviar nada.
                </p>
                <Field
                  id={fieldId('webhook_url')}
                  label="Webhook URL"
                  value={cfg.settings.webhook_url || ''}
                  onChange={(v) => { setSetting('webhook_url', v); if (whTest.state !== 'idle') setWhTest({ state: 'idle', msg: '' }) }}
                  placeholder="https://hooks.ejemplo.com/presencia"
                  help={HELP.webhook_url}
                  onHelp={setHelp}
                  error={liveErrors.webhook_url}
                  warning={liveWarnings.webhook_url}
                />
                <div className="mt-4 flex items-center gap-3 flex-wrap">
                  <button
                    className={btnGhost}
                    onClick={testWebhook}
                    disabled={!whCanTest || whTest.state === 'sending'}
                    aria-disabled={!whCanTest}
                    title={whCanTest ? undefined : whTestDisabledReason}
                  >
                    {whTest.state === 'sending' ? 'Enviando…' : 'Enviar evento de prueba'}
                  </button>
                  {!whCanTest && whUrl === '' && <small className={hintCls}>{whTestDisabledReason}</small>}
                </div>
                {whTest.state === 'ok' && <p className="text-emerald-400 text-sm mt-2">✅ {whTest.msg}</p>}
                {whTest.state === 'error' && <p className="text-red-400 text-sm mt-2">❌ Error: {whTest.msg}</p>}
                <details className="mt-4">
                  <summary className="text-sky-400 text-sm cursor-pointer">Ver schema del payload</summary>
                  <pre className="bg-slate-950 rounded-lg p-3 mt-2 overflow-x-auto text-xs">{JSON.stringify({
                    event: 'device_present',
                    ts: '2026-09-19T10:00:00+00:00',
                    device_name: 'Iphone de Paulo',
                    mac: '00:11:22:33:44:55',
                    ip: '192.168.1.100',
                    status: 'online'
                  }, null, 2)}</pre>
                  <p className="text-xs text-slate-400 mt-2">
                    <code>event</code>: <code>device_present</code> | <code>device_away</code> |{' '}
                    <code>anyone_home</code> | <code>anyone_away</code>. En <code>anyone_*</code> no se
                    incluyen <code>device_name</code>/<code>mac</code>/<code>ip</code>.
                  </p>
                </details>
              </section>

              <section className={cardCls}>
                <h2 className={h2Cls}>Escaneo</h2>
                <p className={descCls}>
                  El escaneo se ejecuta como un job cada 1 minuto (cron). Aquí solo se ajusta la
                  tolerancia y las interfaces.
                </p>
                <div className="grid gap-3 md:grid-cols-2">
                  <Field
                    id={fieldId('grace')}
                    label="Grace (s)"
                    type="number"
                    value={cfg.settings.grace || '180'}
                    onChange={(v) => setSetting('grace', v)}
                    hint="Segundos sin verse antes de marcarse offline"
                    help={HELP.grace}
                    onHelp={setHelp}
                    error={liveErrors.grace}
                  />
                  <Field
                    id={fieldId('scan_prefix')}
                    label="Scan prefix"
                    type="number"
                    value={cfg.settings.scan_prefix || '24'}
                    onChange={(v) => setSetting('scan_prefix', v)}
                    hint="Tamaño máximo de subred a escanear"
                    help={HELP.scan_prefix}
                    onHelp={setHelp}
                    error={liveErrors.scan_prefix}
                  />
                  <Field
                    id={fieldId('notify_cooldown')}
                    label="Cooldown bienvenida (s)"
                    type="number"
                    value={cfg.settings.notify_cooldown || '1800'}
                    onChange={(v) => setSetting('notify_cooldown', v)}
                    hint="Mínimo entre anuncios de «llegó a casa»"
                    help={HELP.notify_cooldown}
                    onHelp={setHelp}
                    error={liveErrors.notify_cooldown}
                  />
                  <Field
                    id={fieldId('away_confirmations')}
                    label="Confirmaciones de ausencia"
                    type="number"
                    value={cfg.settings.away_confirmations || '2'}
                    onChange={(v) => setSetting('away_confirmations', v)}
                    hint="Ciclos seguidos sin señal antes de marcar offline"
                    error={liveErrors.away_confirmations}
                  />
                  <Field
                    id={fieldId('device_notify_cooldown')}
                    label="Cooldown por dispositivo (s)"
                    type="number"
                    value={cfg.settings.device_notify_cooldown || '300'}
                    onChange={(v) => setSetting('device_notify_cooldown', v)}
                    hint="Mínimo entre webhooks del mismo dispositivo"
                    error={liveErrors.device_notify_cooldown}
                  />
                </div>
                <div className="mt-3">
                  <Field
                    id={fieldId('ifaces')}
                    label="Interfaces (IFACES)"
                    value={cfg.settings.ifaces || ''}
                    onChange={(v) => setSetting('ifaces', v)}
                    placeholder="Déjalo vacío (auto) o p. ej. eth0,wlan0"
                    hint="Separadas por coma. Vacío = auto-detección"
                    help={HELP.ifaces}
                    onHelp={setHelp}
                    error={liveErrors.ifaces}
                  />
                </div>
                <div className="mt-3 flex flex-col gap-3">
                  <Switch
                    checked={(cfg.settings.passive_sniff_enabled ?? 'true') === 'true'}
                    onChange={(v) => setBoolSetting('passive_sniff_enabled', v)}
                    label="Escucha pasiva (ARP/mDNS/DHCP)"
                    help={{ title: 'Escucha pasiva (Layer 1)', body: (
                      <>
                        <p>
                          Un daemon en segundo plano escucha el tráfico de la red (ARP, mDNS y DHCP)
                          de forma continua y registra cada vez que ve uno de tus dispositivos. Esto
                          es mucho más fiable que un escaneo puntual, porque no depende de que el
                          dispositivo responda justo en el segundo del escaneo.
                        </p>
                        <p>
                          Desactívalo solo si el hardware no soporta bien el sniffing (necesita{' '}
                          <code>CAP_NET_RAW</code>/<code>CAP_NET_ADMIN</code>); el sistema seguirá
                          funcionando con el escaneo activo.
                        </p>
                      </>
                    ) }}
                    onHelp={setHelp}
                  />
                  <Switch
                    checked={(cfg.settings.use_nmap ?? 'true') === 'true'}
                    onChange={(v) => setBoolSetting('use_nmap', v)}
                    label="Usar nmap como método extra"
                    help={{ title: 'Usar nmap (Layer 2)', body: (
                      <>
                        <p>
                          Ejecuta <code>nmap -sn</code> en paralelo con <code>arp-scan</code> y une
                          los resultados. Al usar implementaciones distintas, cada método detecta
                          hosts que el otro a veces pierde.
                        </p>
                        <p>
                          Además, cuando un dispositivo con IP conocida no aparece en el escaneo,
                          se le envía un probe unicast dirigido (<code>arping</code>/<code>ping</code>)
                          que tiene más probabilidad de despertar su radio.
                        </p>
                      </>
                    ) }}
                    onHelp={setHelp}
                  />
                </div>
                <div className="grid gap-3 md:grid-cols-2 mt-3">
                  <Field
                    id={fieldId('passive_sniff_ifaces')}
                    label="Interfaces de escucha pasiva"
                    value={cfg.settings.passive_sniff_ifaces || ''}
                    onChange={(v) => setSetting('passive_sniff_ifaces', v)}
                    placeholder="Vacío = igual que IFACES"
                    hint="Vacío usa las mismas que Interfaces"
                    error={liveErrors.passive_sniff_ifaces}
                  />
                  <Field
                    id={fieldId('nmap_bin')}
                    label="Ruta a nmap"
                    value={cfg.settings.nmap_bin || 'nmap'}
                    onChange={(v) => setSetting('nmap_bin', v)}
                    hint="Binario usado por el escaneo activo"
                    error={liveErrors.nmap_bin}
                  />
                </div>
              </section>

              <section className={cardCls}>
                <h2 className={h2Cls}>Logs</h2>
                <div className="flex items-center gap-4 mb-3 flex-wrap">
                  <button
                    className={`${btnGhost} ${btnSmall}`}
                    onClick={loadLogs}
                    disabled={logsLoading}
                    aria-disabled={logsLoading}
                  >
                    {logsLoading ? (
                      <>
                        <span className={spinnerLight} aria-hidden="true"></span> Actualizando…
                      </>
                    ) : (
                      'Actualizar'
                    )}
                  </button>
                  <Switch checked={logsAuto} onChange={setLogsAuto} label="Actualizar cada 10s" />
                </div>
                <p className={descCls}>
                  Últimas ejecuciones del job de presencia (cada minuto). Útil para ver por qué no llegó
                  un anuncio de VoiceMonkey: busca <code>voicemonkey announce sent</code> o{' '}
                  <code>failed</code>.
                </p>
                {logs && (
                  <pre className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs leading-relaxed whitespace-pre-wrap break-words max-h-80 overflow-y-auto font-mono" aria-live="polite">
                    {logs.exists ? logs.lines.join('\n') : 'No hay log todavía.'}
                  </pre>
                )}
              </section>

              <div className="mt-2">
                <button className={`${btnPrimary} min-w-44`} onClick={save} disabled={saveState === 'saving' || loading}>
                  {saveState === 'saving' ? (
                    <>
                      <span className={spinner} aria-hidden="true"></span> Guardando…
                    </>
                  ) : (
                    'Guardar configuración'
                  )}
                </button>
              </div>
            </>
          )}
        </>
      )}

      <HelpModal help={help} onClose={() => setHelp(null)} />
    </main>
  )
}