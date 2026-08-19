// Is It Real? — stage machine and choreography.
//
//   approach --button--> hinge --dial--> map --button--> sendoff --30s--> approach
//
// Two physical inputs drive the whole piece, matching the plinth: one button and one rotary
// control. The button takes the exposure, then later keeps it; the dial does everything in
// between. The on-screen shutter and slider fire the same two actions, so it runs without
// hardware attached.
//
// Every wait and animation is tagged with a generation number. restart() bumps it, which
// cancels in-flight animations and leaves pending waits unresolved, so an abandoned turn can
// never bleed into the next visitor's.

import { startCamera } from './camera.js'
import { captureIntensity, drawMapped, mappedURL } from './imaging.js'
import { COLORMAPS, drawSwatch } from './colormaps.js'
import { loadNebula, NEBULA_CREDIT } from './nebula.js'
import { connectPlinth, serialSupported } from './serial.js'
import { publish as publishToWall } from './store.js'

// ── the knobs you'll actually want to turn ──────────────────────────────────

const TIMELINE = {
  freezeHold: 160, // beat between the flash and the hinge, so the freeze registers
  hingeHold: 3400, // the fulcrum. Deliberately long — do not rush this one.
  mapCrossfade: 520,
  nebulaIn: 260,
  keepHint: 2400, // how long they explore before being told they can keep it
  verdict: 300,
  restartButtonAt: 5000,
  autoRestartAt: 30000,
}

const CAPTURE_W = 960 // exposure resolution, also what gets published

// Compress the whole sequence for anyone who asked the OS for less motion.
const PACE = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.25 : 1
const t = (ms) => Math.round(ms * PACE)
const EASE = 'cubic-bezier(.16, 1, .3, 1)'

const $ = (id) => document.getElementById(id)
const feed = $('feed')
const shutter = $('shutter')
const flash = $('flash')
const portraitCanvas = $('portraitCanvas')
const nebulaCanvas = $('nebulaCanvas')
const knob = $('knob')
const keepBtn = $('keepBtn')
const restartBtn = $('restart')

// Which <section> is on screen for each stage. hinge/map/sendoff share one section so the
// frozen portrait never has to be re-positioned between them.
const SECTION_FOR = { approach: 'approach', hinge: 'study', map: 'study', sendoff: 'study' }

let gen = 0
let anims = []
let timers = []

let exposure = null // { intensity, width, height } — written once, then read-only
let nebula = null
let paletteIndex = 0
let plinth = null

// ── timing + animation, all cancellable ─────────────────────────────────────

function wait(ms) {
  const g = gen
  return new Promise((resolve) => {
    timers.push(setTimeout(() => g === gen && resolve(), ms))
  })
}

function later(ms, fn) {
  const g = gen
  timers.push(setTimeout(() => g === gen && fn(), ms))
}

function cancelAll() {
  gen++
  timers.forEach(clearTimeout)
  timers = []
  anims.forEach((a) => a.cancel())
  anims = []
}

function track(anim) {
  anims.push(anim)
  return anim
}

function pop(node, delay = 0) {
  if (!node) return null
  return track(
    node.animate(
      [
        { opacity: 0, transform: 'translateY(20px) scale(.88)', offset: 0 },
        { opacity: 1, transform: 'translateY(0) scale(1.03)', offset: 0.62 },
        { opacity: 1, transform: 'translateY(0) scale(1)', offset: 1 },
      ],
      { duration: t(640), delay: t(delay), easing: EASE, fill: 'both' }
    )
  )
}

function rise(node, delay = 0) {
  if (!node) return null
  return track(
    node.animate([{ opacity: 0, transform: 'translateY(46px)' }, { opacity: 1, transform: 'none' }], {
      duration: t(700),
      delay: t(delay),
      easing: EASE,
      fill: 'both',
    })
  )
}

/** Run the entrances for one sub-stage: every marked element inside `root`. */
function revealAll(root) {
  if (!root) return
  root.querySelectorAll('.pop, .rise').forEach((node) => {
    const delay = Number(node.dataset.d) || 0
    if (node.classList.contains('rise')) rise(node, delay)
    else pop(node, delay)
  })
}

function setStage(name) {
  const section = SECTION_FOR[name]
  document.querySelectorAll('.stage').forEach((s) => s.classList.toggle('active', s.dataset.for === section))
  document.body.dataset.stage = name
}

const stage = () => document.body.dataset.stage

function setAspect(w, h) {
  if (w && h) document.documentElement.style.setProperty('--shot-ar', (w / h).toFixed(4))
}

// ── the colormap dial ───────────────────────────────────────────────────────

function applyPalette(index) {
  paletteIndex = Math.max(0, Math.min(COLORMAPS.length - 1, index))
  const map = COLORMAPS[paletteIndex]

  knob.value = String(paletteIndex)
  knob.style.setProperty('--fill', `${(paletteIndex / (COLORMAPS.length - 1)) * 100}%`)
  $('paletteName').textContent = map.name
  $('paletteNote').textContent = map.note
  $('chosenPalette').textContent = map.name
  drawSwatch($('swatch'), map)

  // The one operation the visitor controls: a lookup table over an untouched intensity array.
  if (exposure) drawMapped(portraitCanvas, exposure, map)
  if (nebula) drawMapped(nebulaCanvas, nebula, map)
}

/** Rotary 0..1023 -> palette index. */
function dialToIndex(raw) {
  return Math.round((raw / 1023) * (COLORMAPS.length - 1))
}

function onDial(index) {
  if (stage() === 'hinge') {
    runMap(index) // the first turn of the dial is what advances the piece
    return
  }
  if (stage() !== 'map') return
  applyPalette(index)
}

// ── the one button ──────────────────────────────────────────────────────────

function onButton() {
  if (stage() === 'approach') takeExposure()
  else if (stage() === 'map') keepIt()
}

// ── 1. approach ─────────────────────────────────────────────────────────────

async function boot() {
  applyPalette(0)
  setStage('approach')

  const params = new URLSearchParams(location.search)
  try {
    await startCamera(feed, { want: params.get('cam') })
    setAspect(feed.videoWidth, feed.videoHeight)
    feed.addEventListener('loadedmetadata', () => setAspect(feed.videoWidth, feed.videoHeight))
    shutter.disabled = false
  } catch (err) {
    shutter.disabled = true
    const box = $('camError')
    box.hidden = false
    box.textContent = `No camera: ${err.message}`
  }

  revealAll(document.querySelector('.stage-approach'))

  // Optional: bind the plinth's real controls, only when asked for with ?plinth.
  if (serialSupported() && params.has('plinth')) {
    try {
      plinth = await connectPlinth({
        onDial: (raw) => onDial(dialToIndex(raw)),
        onButtonPress: onButton,
      })
    } catch {
      /* fall back to the on-screen controls */
    }
  }
}

async function takeExposure() {
  if (!feed.videoWidth) return
  shutter.disabled = true

  flash.classList.remove('go')
  void flash.offsetWidth // restart the flash animation
  flash.classList.add('go')

  exposure = captureIntensity(feed, CAPTURE_W)
  if (!exposure) {
    shutter.disabled = false
    return
  }

  setAspect(exposure.width, exposure.height)
  applyPalette(0) // the exposure appears as what it is: grayscale
  await wait(t(TIMELINE.freezeHold))
  runHinge()
}

// ── 2. the hinge beat ───────────────────────────────────────────────────────

async function runHinge() {
  setStage('hinge')
  revealAll(document.querySelector('.hinge'))

  // Build the telescope frame at the portrait's exact dimensions while they're reading, so
  // the two panes match and the dial has something to recolour the instant it's touched.
  loadNebula(exposure.width, exposure.height).then((frame) => {
    if (!exposure) return // they restarted while it was loading
    nebula = frame
    $('nebulaCaption').textContent = NEBULA_CREDIT.label
    drawMapped(nebulaCanvas, nebula, COLORMAPS[paletteIndex])
  })

  await wait(t(TIMELINE.hingeHold))
  document.body.classList.add('invite-dial') // CSS fades in "Turn the dial"
}

// ── 3. the map beat ─────────────────────────────────────────────────────────

async function runMap(index) {
  setStage('map')
  document.body.classList.remove('invite-dial')
  applyPalette(index)

  await wait(t(TIMELINE.mapCrossfade))
  revealAll(document.querySelector('.map-head'))
  pop(document.querySelector('.pane-sky'), TIMELINE.nebulaIn)

  // Let them explore before offering the way out, so the dial is the focus first.
  await wait(t(TIMELINE.keepHint))
  rise(keepBtn)
}

// ── 4. send-off ─────────────────────────────────────────────────────────────

function keepIt() {
  const map = COLORMAPS[paletteIndex]
  publishToWall({ image: mappedURL(exposure, map), palette: map.name })
  runSendoff()
}

async function runSendoff() {
  setStage('sendoff')
  document.body.classList.remove('invite-dial')

  later(t(TIMELINE.restartButtonAt), () => rise(restartBtn))
  later(t(TIMELINE.autoRestartAt), restart)

  await wait(t(TIMELINE.verdict))
  revealAll(document.querySelector('.sendoff'))
}

// ── restart ─────────────────────────────────────────────────────────────────

function restart() {
  cancelAll()

  exposure = null
  nebula = null
  document.body.classList.remove('invite-dial')
  applyPalette(0)

  setStage('approach')
  setAspect(feed.videoWidth, feed.videoHeight)
  shutter.disabled = !feed.videoWidth
  revealAll(document.querySelector('.stage-approach'))
}

// ── wiring ──────────────────────────────────────────────────────────────────

shutter.addEventListener('click', onButton)
keepBtn.addEventListener('click', onButton)
knob.addEventListener('input', () => onDial(Number(knob.value)))
restartBtn.addEventListener('click', restart)

// Keyboard equivalents for the two physical inputs, for testing without the plinth.
addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault()
    onButton()
  }
  if (e.key === 'ArrowRight') onDial(paletteIndex + 1)
  if (e.key === 'ArrowLeft') onDial(paletteIndex - 1)
})

addEventListener('beforeunload', () => plinth && plinth.close())

boot()
