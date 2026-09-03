// An in-situ performance readout.
//
// The exhibit machine is not the machine this was written on, and the numbers that matter are
// the ones it reports standing on the floor. So the meter travels with the build: no cable, no
// desktop debugger, no rebuild to turn it on.
//
//   ?perf=1              on from the URL, for a bench session
//   press P              on a machine with a keyboard
//   hold the top-left    1.5s anywhere in the top-left 72px, for a touchscreen in situ
//
// Alongside it, and deliberately a separate thing, is the debug menu at the bottom of this
// file: the readout tells you what is happening, the menu lets you change it.
//
// It never persists across a reload, so a HUD left on by accident cannot outlive the session,
// and it costs nothing while it is off — the sampling loop only runs when it is showing.

const CORNER = 72 // px square in the top-left that arms the long press
const HOLD = 1500 // ms to hold before it toggles
const REPAINT = 250 // ms between DOM writes; sampling is per frame, drawing is not

let on = false
let box = null
let raf = 0
let lastFrame = 0
let lastPaint = 0

// Rolling frame intervals, and the cost of whatever work asked to be timed.
const frames = []
const spans = new Map() // label -> { times: [], last: 0 }

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0)
const worst = (a) => (a.length ? Math.max(...a) : 0)
const ms = (n) => (n < 10 ? n.toFixed(2) : n.toFixed(1))

/**
 * Time a span of work. Costs one `performance.now()` pair while the HUD is on and returns the
 * callback's value untouched, so it can wrap a call site without changing it.
 */
export function measure(label, fn) {
  if (!on) return fn()
  const t0 = performance.now()
  const out = fn()
  const dt = performance.now() - t0
  let s = spans.get(label)
  if (!s) spans.set(label, (s = { times: [], last: 0 }))
  s.times.push(dt)
  s.last = dt
  if (s.times.length > 90) s.times.shift()
  return out
}

/**
 * Note that something happened, to show a rate rather than a duration. Windowed over the last
 * couple of seconds: a rate averaged since the counter was created reads low forever once the
 * exhibit goes idle, which is exactly when someone is standing there reading it.
 */
const RATE_WINDOW = 2000
export function count(label) {
  if (!on) return
  let s = spans.get(label)
  if (!s) spans.set(label, (s = { times: [], last: 0, hits: [] }))
  s.hits.push(performance.now())
}

// Facts worth reading on the device, recorded whether or not the HUD is showing — by the time
// someone thinks to open it, the thing they need to know has usually already happened.
const info = new Map()

/** Record a line for the HUD's facts panel. Pass null to clear one. */
export function setInfo(key, value) {
  if (value == null) info.delete(key)
  else info.set(key, String(value))
}

// Facts that are only true for an instant. A probe is read on every repaint instead of being
// recorded once, which is what you need for anything that is supposed to be *changing* — a
// clock that is not advancing says something a snapshot of it never could.
const probes = new Map()

/** Register a live line for the HUD. `fn` returns the text, and may contain newlines. */
export function setProbe(key, fn) {
  if (fn == null) probes.delete(key)
  else probes.set(key, fn)
}

function build() {
  box = document.createElement('div')
  box.id = 'perfHud'
  // pointer-events:none throughout — a debugging overlay must never be able to eat a visitor's
  // touch, including the one that would turn it off again.
  box.style.cssText = `
    position: fixed; top: 10px; left: 10px; z-index: 99999;
    padding: 9px 12px; border-radius: 8px;
    background: rgba(6, 8, 12, .82); color: #dfe6f2;
    border: 1px solid rgba(255, 255, 255, .16);
    font: 11px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    white-space: pre; pointer-events: none;
    text-shadow: 0 1px 2px rgba(0, 0, 0, .8);`
  document.body.append(box)
}

function tick(now) {
  if (!on) return
  if (lastFrame) {
    frames.push(now - lastFrame)
    if (frames.length > 180) frames.shift()
  }
  lastFrame = now

  if (now - lastPaint >= REPAINT) {
    lastPaint = now
    paint(now)
  }
  raf = requestAnimationFrame(tick)
}

function paint(now) {
  const mid = median(frames)
  const fps = mid > 0 ? 1000 / mid : 0
  // Long frames are the number that actually matters: an average hides the stutter people see.
  const long = frames.filter((f) => f > 25).length

  const lines = [
    `${fps.toFixed(0).padStart(3)} fps    frame ${ms(mid).padStart(6)} ms  worst ${ms(worst(frames)).padStart(6)}`,
    `over 25ms  ${String(long).padStart(3)} of ${String(frames.length).padStart(3)} frames`,
  ]

  for (const [label, s] of spans) {
    if (s.hits) {
      while (s.hits.length && s.hits[0] < now - RATE_WINDOW) s.hits.shift()
      const per = (s.hits.length / (RATE_WINDOW / 1000)).toFixed(0)
      lines.push(`${label.padEnd(11)}${per.padStart(6)} /s`)
    } else if (s.times.length) {
      lines.push(
        `${label.padEnd(11)}${ms(median(s.times)).padStart(6)} ms  worst ${ms(worst(s.times)).padStart(6)}`
      )
    }
  }

  if (info.size || probes.size) {
    lines.push('')
    for (const [k, fn] of probes) {
      let v
      try {
        v = String(fn())
      } catch (err) {
        v = `probe failed: ${err.message}`
      }
      const rows = v.split('\n')
      lines.push(`${k.padEnd(11)}${rows[0]}`)
      for (const extra of rows.slice(1)) lines.push(`${' '.repeat(11)}${extra}`)
    }
    for (const [k, v] of info) {
      const rows = v.split('\n')
      lines.push(`${k.padEnd(11)}${rows[0]}`)
      for (const extra of rows.slice(1)) lines.push(`${' '.repeat(11)}${extra}`)
    }
    lines.push('')
  }

  // Growth here across visitors is the signature of a leak, and it is the only way to see one
  // on a kiosk you cannot attach a debugger to.
  const heap = performance.memory?.usedJSHeapSize
  lines.push(
    `nodes ${String(document.getElementsByTagName('*').length).padStart(5)}` +
      `  canvas ${String(document.getElementsByTagName('canvas').length).padStart(3)}` +
      (heap ? `  heap ${(heap / 1048576).toFixed(1)} MB` : '')
  )

  const stage = document.body.dataset.stage ?? '-'
  lines.push(`stage ${stage}${document.body.dataset.split ? ' · split' : ''}   dpr ${window.devicePixelRatio || 1}`)
  lines.push(`${innerWidth}x${innerHeight}  hold top-left or P to hide`)
  box.textContent = lines.join('\n')
}

export function toggle(next = !on) {
  on = next
  if (on) {
    if (!box) build()
    box.style.display = 'block'
    frames.length = 0
    spans.clear()
    lastFrame = 0
    lastPaint = 0
    raf = requestAnimationFrame(tick)
  } else {
    cancelAnimationFrame(raf)
    raf = 0
    if (box) box.style.display = 'none'
  }
}

export const showing = () => on

// ── the debug menu ─────────────────────────────────────────────────────────────
//
// The HUD above is a readout, and stays pointer-events:none because an overlay that can eat a
// visitor's touch is a fault however useful it is. This is the other half: a panel that exists
// to be clicked. Being interactive is safe here precisely because it cannot be opened by
// touching the screen — it takes a keyboard, or a query string typed into the address bar.
//
//   ?debug=1             on from the URL
//   ctrl + shift + D     on a machine with a keyboard
//
// Actions register themselves from wherever the state they change lives, rather than being
// listed here, so this file never has to know what a camera rotation is.

const actions = []
let menu = null
let rows = null
let menuOn = false

/**
 * Add a button to the debug menu.
 *
 * `run` does the thing. `state`, if given, returns a short string shown beside the label and
 * re-read on every redraw, so a button that changes something can show what it changed it to.
 */
export function addDebugAction({ label, hint, run, state }) {
  actions.push({ label, hint, run, state })
  if (menuOn) drawMenu()
}

function buildMenu() {
  menu = document.createElement('div')
  menu.id = 'debugMenu'
  // Top right: the HUD has the top left, and so does the long-press corner that opens it.
  menu.style.cssText = `
    position: fixed; top: 10px; right: 10px; z-index: 99999;
    width: 264px; padding: 11px; border-radius: 10px;
    background: rgba(6, 8, 12, .93); color: #dfe6f2;
    border: 1px solid rgba(255, 255, 255, .22);
    font: 12px/1.45 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    box-shadow: 0 18px 50px rgba(0, 0, 0, .6);`

  const head = document.createElement('div')
  head.textContent = 'debug'
  head.style.cssText =
    'letter-spacing:.18em;text-transform:uppercase;opacity:.55;margin-bottom:9px'

  rows = document.createElement('div')
  rows.style.cssText = 'display:flex;flex-direction:column;gap:6px'

  const foot = document.createElement('div')
  foot.textContent = 'esc, or ctrl+shift+D, to close'
  foot.style.cssText = 'margin-top:10px;opacity:.45'

  menu.append(head, rows, foot)
  document.body.append(menu)
}

function drawMenu() {
  rows.replaceChildren()

  if (!actions.length) {
    const empty = document.createElement('div')
    empty.textContent = 'nothing registered'
    empty.style.opacity = '.5'
    rows.append(empty)
    return
  }

  for (const a of actions) {
    const button = document.createElement('button')
    button.type = 'button'
    // Roomy enough to hit with a finger: this may well be opened on the kiosk itself with a
    // keyboard plugged in, rather than at a desk with a mouse.
    button.style.cssText = `
      display:flex; justify-content:space-between; align-items:baseline; gap:10px;
      width:100%; padding:9px 11px; text-align:left; cursor:pointer;
      border-radius:7px; border:1px solid rgba(255,255,255,.18);
      background:rgba(255,255,255,.06); color:inherit; font:inherit;`

    const name = document.createElement('span')
    name.textContent = a.label
    button.append(name)

    if (a.state) {
      const value = document.createElement('span')
      // A reporting function that throws must not take the whole menu down with it — the menu
      // is most wanted on exactly the machine where something is already going wrong.
      try {
        value.textContent = String(a.state())
      } catch (err) {
        value.textContent = '?'
      }
      value.style.cssText = 'opacity:.65;white-space:nowrap'
      button.append(value)
    }

    button.addEventListener('click', () => {
      try {
        a.run()
      } catch (err) {
        console.error(`debug action "${a.label}" failed`, err)
      }
      // Redraw every row, not the one that was pressed: one action may well change what
      // another one reports.
      drawMenu()
    })

    rows.append(button)

    if (a.hint) {
      const hint = document.createElement('div')
      hint.textContent = a.hint
      hint.style.cssText = 'opacity:.4;margin:-2px 2px 2px'
      rows.append(hint)
    }
  }
}

export function toggleDebug(next = !menuOn) {
  menuOn = next
  if (menuOn) {
    if (!menu) buildMenu()
    menu.style.display = 'block'
    drawMenu()
  } else if (menu) {
    menu.style.display = 'none'
  }
}

/** Wire the three ways in. Safe to call once at boot; does nothing until something asks. */
export function initPerf() {
  const q = new URLSearchParams(location.search)
  setInfo('build', typeof __BUILD__ === 'string' ? __BUILD__ : 'dev')

  // ?fx=lite strips the blur, blend and idle animations; ?fx=off also drops the light shafts.
  const fx = q.get('fx')
  if (fx === 'lite' || fx === 'off') {
    document.body.dataset.fx = fx
    setInfo('fx', fx === 'off' ? 'off - no shafts, no blur, no blend' : 'lite - no blur, no blend, no idle animation')
  }

  if (q.get('perf') === '1') toggle(true)
  if (q.get('debug') === '1') toggleDebug(true)

  addEventListener('keydown', (e) => {
    // A modifier for the menu, a bare key for the readout. The menu has buttons that *do*
    // things, so it should not be one stray keystroke away.
    if (e.ctrlKey && e.shiftKey && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault()
      toggleDebug()
      return
    }
    if (e.key === 'Escape') {
      toggleDebug(false)
      return
    }
    // Ctrl+P is print, and taking that over on a machine somebody is debugging on is rude.
    if (e.ctrlKey || e.altKey || e.metaKey) return
    if (e.key === 'p' || e.key === 'P') toggle()
  })

  // Long-press the top-left corner. Capture phase and entirely passive: it never calls
  // preventDefault and never stops propagation, so an accidental press in that corner behaves
  // exactly as it would have without this listener.
  let held = 0
  addEventListener(
    'pointerdown',
    (e) => {
      if (e.clientX > CORNER || e.clientY > CORNER) return
      clearTimeout(held)
      held = setTimeout(() => toggle(), HOLD)
    },
    { capture: true, passive: true }
  )
  for (const end of ['pointerup', 'pointercancel', 'pointerleave']) {
    addEventListener(end, () => clearTimeout(held), { capture: true, passive: true })
  }
}
