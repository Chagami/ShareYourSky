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
let text = null // the readout inside it
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

  // The readout is rewritten several times a second, so it has an element of its own and the
  // button beside it is left alone.
  text = document.createElement('div')
  text.style.cssText = 'padding-right: 46px; min-height: 40px'

  // The one part of the overlay that can be touched, so it can be closed on a kiosk with no
  // keyboard. Small and in its own corner: the rest stays pointer-events: none, for the reason
  // above.
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '×'
  close.title = 'Close'
  close.setAttribute('aria-label', 'Close the performance overlay')
  close.style.cssText = `
    position: absolute; top: 6px; right: 6px; width: 40px; height: 40px; padding: 0;
    pointer-events: auto; cursor: pointer;
    border: 1px solid rgba(255, 255, 255, .22); border-radius: 9px;
    background: rgba(255, 255, 255, .06); color: inherit; text-shadow: none;
    font: 20px/1 ui-monospace, Menlo, Consolas, monospace;`
  close.addEventListener('click', () => toggle(false))

  box.append(text, close)
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
  text.textContent = lines.join('\n')
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
// to be clicked. Being interactive is safe because nobody opens it by accident: the one way in
// from the screen is a deliberate run of taps on marks that do nothing else, which a pause of
// a couple of seconds throws away (see wireDebugKnock in main.js).
//
//   ?debug=1                          on from the URL
//   ctrl + shift + D                  on a machine with a keyboard
//   1. Photo five times, 2. Adjust    on the kiosk; the × in its corner closes it
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

/**
 * Add a slider to the debug menu.
 *
 * For the settings that are a quantity rather than a choice — how far to turn something, how
 * much to trim. `get` is read when the menu is drawn, `set` is called on every movement, so
 * whatever it changes should be cheap enough to change while a finger is on it.
 */
/**
 * Draw the menu again, if it is open. For an action whose outcome arrives later than its press —
 * one that has to ask the server — so its row can show how it went once it knows.
 */
export function refreshDebug() {
  if (menuOn) drawMenu()
}

export function addDebugSlider({ label, hint, min = 0, max = 100, step = 1, get, set, format }) {
  actions.push({ slider: true, label, hint, min, max, step, get, set, format })
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
    box-shadow: 0 18px 50px rgba(0, 0, 0, .6);
    /* It grows a row every time something is added to it, and the screen it opens on is not
       always the tall one. */
    max-height: calc(100dvh - 20px); overflow-y: auto;`

  const head = document.createElement('div')
  head.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px'

  const title = document.createElement('span')
  title.textContent = 'debug'
  title.style.cssText = 'letter-spacing:.18em;text-transform:uppercase;opacity:.55'

  // The only way out of here used to be a keyboard, on a machine whose whole point is that it
  // has no keyboard. Forty pixels because that is the smallest thing a finger reliably hits.
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '\u00d7'
  close.title = 'Close'
  close.setAttribute('aria-label', 'Close the debug menu')
  close.style.cssText = `
    flex: none; width: 40px; height: 40px; margin: -9px -6px -9px 0; padding: 0;
    border: 1px solid rgba(255, 255, 255, .22); border-radius: 9px;
    background: rgba(255, 255, 255, .06); color: inherit;
    font: 20px/1 ui-monospace, Menlo, Consolas, monospace; cursor: pointer;`
  close.addEventListener('click', () => toggleDebug(false))
  head.append(title, close)

  rows = document.createElement('div')
  rows.style.cssText = 'display:flex;flex-direction:column;gap:6px'

  const foot = document.createElement('div')
  foot.textContent = 'the \u00d7, esc, or ctrl+shift+D, to close'
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
    if (a.slider) {
      const row = document.createElement('div')
      row.style.cssText = 'padding:7px 2px 3px'

      const head = document.createElement('div')
      head.style.cssText = 'display:flex;justify-content:space-between;gap:10px;margin-bottom:5px'
      const name = document.createElement('span')
      name.textContent = a.label
      const value = document.createElement('span')
      value.style.cssText = 'opacity:.65;white-space:nowrap'
      head.append(name, value)

      const input = document.createElement('input')
      input.type = 'range'
      input.min = String(a.min)
      input.max = String(a.max)
      input.step = String(a.step)
      input.style.cssText = 'width:100%;accent-color:#ff8a2b;margin:0'

      const show = () => {
        let now = a.min
        try {
          now = a.get()
        } catch {
          // A reporting function that throws must not take the menu down with it.
        }
        input.value = String(now)
        value.textContent = a.format ? a.format(now) : String(now)
      }
      input.addEventListener('input', () => {
        try {
          a.set(Number(input.value))
        } catch (err) {
          console.error(`debug slider "${a.label}" failed`, err)
        }
        value.textContent = a.format ? a.format(Number(input.value)) : input.value
      })

      show()
      row.append(head, input)
      rows.append(row)

      if (a.hint) {
        const hint = document.createElement('div')
        hint.textContent = a.hint
        hint.style.cssText = 'opacity:.4;margin:2px 2px 4px'
        rows.append(hint)
      }
      continue
    }

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
  // The page's service notes (a camera fault's cause, its retry count) show only while this is
  // open. Everything on screen without it is for visitors.
  document.documentElement.classList.toggle('debug-open', menuOn)
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

  // ?fx=lite strips the blur and the idle animations; ?fx=off also takes the glow off.
  const fx = q.get('fx')
  if (fx === 'lite' || fx === 'off') {
    document.body.dataset.fx = fx
    setInfo('fx', fx === 'off' ? 'off - no blur, no idle animation, no glow' : 'lite - no blur, no idle animation')
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
