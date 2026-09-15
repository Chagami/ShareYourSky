// Share Your Sky — stage machine and choreography.
//
//   live --shutter--> countdown --> work[ intro | R | G | B | reveal | finale ] --> thanks
//
// The work stage is one screen with an anchored photo and a swapping right-hand panel, so the
// image never jumps and the controls never move out from under the visitor's hand.
//
// Every wait and animation carries a generation number. reset() bumps it, cancelling in-flight
// animations and leaving pending waits unresolved, so an abandoned turn cannot bleed into the
// next visitor's.

import { startCamera, CameraSetupError, reportCameras } from './camera.js'
import {
  CHANNELS, captureFrame, frameFromImage, downscaleFrame, levelsLut, hueTint, ZERO_LUT,
  drawComposite, compositeURL,
} from './imaging.js'
import { createLevels } from './levels.js'
import {
  initPerf,
  measure,
  count,
  setProbe,
  setInfo,
  addDebugAction,
  addDebugSlider,
  toggleDebug,
  toggle as togglePerf,
  showing as perfShowing,
} from './perf.js'
import { publish as publishToWall } from './store.js'

// ── the knobs you'll actually want to turn ──────────────────────────────────

const TIMELINE = {
  countdownFrom: 5,
  countdownTick: 900, // 5-4-3-2-1 at this cadence
  freezeHold: 420, // the flash, before the photo is handed to the next step

  stepIn: 420, // a step arriving
  blob: 620, // the indicator's blob stretching across to the next mark

  // Step 2, in the order it happens.
  photoFlight: 900, // the viewfinder shrinking into the corner of the editing screen
  storyLeadIn: 300, // it lands, and then the sentence starts
  blockFade: 700, // a paragraph arriving, whole
  readHold: 900, // ...and read, before the colours start
  channelStep: 1300, // one colour lighting to the next
  afterGap: 1000, // the three layers out, before the second paragraph
  assembleWait: 900, // ...read, before the layers start moving into the frame
  fly: 1000, // one layer's trip into the frame
  flyGap: 260, // and the pause before the next sets off

  // The picture's journey through the share question. It pulls out of shape on the screen it is
  // leaving, holds there, spins in from the left onto this one, and then leaves to one side or
  // the other according to the answer.
  stretch: 620, // pulling out of shape on the way out of the adjust screen
  stretchHold: 420, // ...and held there, so the arrival reads as the release
  spin: 1800, // in from the left, turning, into the middle of the share question
  spinOut: 950, // yes: away to the right, when there is no wall to join
  feather: 2600, // no: down, slowly, the long way

  // ...and yes, when there is. The two strips stop, a space opens, the picture turns into it.
  reelStop: 460, // both strips easing to a halt
  reelGapOpen: 540, // a space opening in one of them
  reelJoin: 1150, // the picture turning down into that space
  reelSettle: 480, // a beat with it sitting there, one of the wall
  reelZoom: 950, // and both strips away to the right

  // Step 3, which asks its question and then hands back the controls.
  lineGap: 520, // between the two sentences of the question
  askHold: 1000, // the question, finished and read, before the colours are offered
  phaseSwap: 720, // the picture moving aside to make room for the charts

  // Step 4, which opens on an empty screen.
  astroHold: 1200, // the line about the gallery, read before the famous photo arrives
  astroPicIn: 700, // the photo fading up
  astroChartIn: 300, // between one chart arriving and the next

  handlePulseAt: 260, // the handles start asking to be touched, once they have settled
  levelsSettleAt: 320, // the handles wait for the charts to land before they move...
  levelsSettle: 700, // ...then slide from the ends of the track to the channel's own range

  cameraRetryAt: 15000, // a camera that will not open is retried until it does
}

// Longest edge, not width — see captureFrame. The camera is asked for 4K, and this is what is
// kept of it: about 3.8 megapixels, four times what the old 1280x720 request produced. The cap
// exists because the whole cost of a bigger picture lands in one place — the JPEG written when
// a visitor shares — and beyond this it becomes a pause they can see.
const CAPTURE_EDGE = 2600

// What every redraw during a drag actually works on. Full capture resolution is 2.6 million
// pixels a frame and the photo is never shown wider than about a thousand of them — three
// times the work for a difference nobody can see, on the device least able to afford it.
// What every redraw works on while the sliders move, so this is the one number here with a
// per-frame cost. 1600 on the longest edge is 1200 across for an upright photo, which covers
// the ~1100px the picture is actually shown at on the kiosk — under that it was being upscaled
// on screen, which is its own kind of soft.
const VIEW_EDGE = 1600
// The three channel layers beside it are a fifth of the width and never redraw, so they can be
// a fifth of the pixels.
const THUMB_EDGE = 340
// The famous photo is 1280x1335, so this keeps all of it. It was 900, which threw away a third
// of a picture the piece then invites the visitor to look at closely.
const PILLARS_EDGE = 1400

// A sideways-mounted camera. Which way it is turned is a property of the bracket it is screwed
// to and not of the exhibit, so it is set on the machine rather than in the code — on the kiosk
// shortcut as ?rot=90 / 180 / 270, or from the debug menu, which remembers it.
const ROT_KEY = 'sharedsky.rot'
const normRot = (n) => (Number.isFinite(n) ? (((Math.round(n / 90) * 90) % 360) + 360) % 360 : 0)

// An explicit ?rot= beats anything remembered, so a machine can always be put back to a known
// orientation from the address bar without clearing storage first.
let camRot = (() => {
  const asked = new URLSearchParams(location.search).get('rot')
  if (asked != null) return normRot(Number(asked))
  try {
    const saved = localStorage.getItem(ROT_KEY)
    if (saved != null) return normRot(Number(saved))
  } catch {
    // Storage disabled or private mode. The default below is a perfectly good answer.
  }
  return 270
})()

const PACE = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.3 : 1
// A marquee has no duration to shorten — the honest answer to "reduce motion" is to hold it
// still and let it be a row of pictures.
const STILL = matchMedia('(prefers-reduced-motion: reduce)').matches
const t = (ms) => Math.round(ms * PACE)
const EASE = 'cubic-bezier(.16, 1, .3, 1)'

const $ = (id) => document.getElementById(id)
const feed = $('feed')
const shutter = $('shutter')
const flash = $('flash')
const countdownEl = $('countdown')
const photoA = $('photoA')
const photoB = $('photoB')
const photoStack = $('photoStack')
const liveFrame = document.querySelector('.live-frame')
const storyEl = $('story')
const storyAfterEl = $('storyAfter')
const chanLayers = $('chanLayers')
const fliers = $('fliers')
const adjustSplit = $('adjustSplit')
const adjustPic = $('adjustPic')
const adjustCanvas = $('adjustCanvas')
const adjustStoryEl = $('adjustStory')
const adjustChannels = $('adjustChannels')
const astroLeadEl = $('astroLead')
const astroSplit = $('astroSplit')
const astroChannels = $('astroChannels')
const astroStoryEl = $('astroStory')
const pillarsPic = $('pillarsPic')
const pillarsCanvas = $('pillarsCanvas')
const pillarsSrc = $('pillarsSrc')
const stepBar = $('stepBar')
const stepsBar = $('stepsBar')
const stepBlob = $('stepBlob')
const nextBtn = $('nextBtn')
const submitBtn = $('submitBtn')
const noBtn = $('noBtn')
const yesBtn = $('yesBtn')
const resetBtn = $('resetBtn')
const slidersTitle = $('slidersTitle')
const confirmAsk = $('confirmAsk')
const confirmPic = $('confirmPic')
const confirmCanvas = $('confirmCanvas')
const liveCrop = $('liveCrop')
const reelTop = $('reelTop')
const reelBottom = $('reelBottom')
const DOCK = [shutter, nextBtn, submitBtn, noBtn, yesBtn, resetBtn]

/**
 * The four steps, in order. Each owns one screen and one action in the dock.
 *
 * `enter` runs when the step is opened, and is the only place a step's content is built. That
 * is what makes them separable: any of them can be opened directly with `?step=edit` without
 * running the ones before it, which is how they get worked on individually.
 */
/**
 * The four steps, and which station of the bar each stands at.
 *
 * `mark` is separate from the step's own position because they no longer line up: step 2 has no
 * controls left on it — it is the camera's photograph being explained — so it stands at Photo
 * with step 1 rather than at Adjust. Adjust is step 3, where the colours are actually moved,
 * and Share lights for the moment between pressing the button and the last screen opening.
 */
const STEPS = [
  { id: 'camera', action: ['shutter'], mark: 0 },
  { id: 'edit', action: ['nextBtn'], mark: 0 },
  { id: 'adjust', action: ['submitBtn'], mark: 1 },
  { id: 'confirm', action: ['noBtn', 'yesBtn'], mark: 2 },
  { id: 'astro', action: ['resetBtn'], mark: 3 },
]
const STEP_IDS = STEPS.map((s) => s.id)


let gen = 0
let anims = []
let timers = []

let frame = null // { width, height, planes, luma, histograms, rest } — written once, read-only after
let viewFrame = null // the same photo, small enough to redraw on every pointermove
let thumbFrame = null // ...and smaller still, for the three channel layers on step 2
let levels = null // [{black, white} x3] — the only thing the visitor changes

// The colour each channel's light is being shown in, in degrees around the spectrum. Starts on
// each channel's own hue, which is where a camera leaves it; step 3 lets the visitor move them
// anywhere, independently — two channels can share a colour, and the picture is their sum.
let shownHue = CHANNELS.map((c) => c.hue)
let recoloured = false

// Step 4 works on a different picture with a different set of numbers, so that adjusting the
// famous photo cannot quietly rewrite what the visitor already shared.
let pillarsFrame = null
let pillarsReady = null
let astroLevels = null
let bigEditors = []
let front = photoA // which stacked canvas is currently showing

// Step 2's own state. `flightFrom` is where the viewfinder was standing at the moment of the
// shutter, measured on step 1 because by the time step 2 can ask, step 1 is off screen.
let flightFrom = null
// Charts the visitor has already taken hold of. A chart is touchable from the moment its beam
// reaches it, which is about 700ms before its opening slide has finished — and without this,
// those are 700ms in which a drag is quietly undone by the animation still running underneath.
const touchedChannels = new Set()

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
        { opacity: 0, transform: 'translateY(18px) scale(.9)', offset: 0 },
        { opacity: 1, transform: 'translateY(0) scale(1.02)', offset: 0.62 },
        { opacity: 1, transform: 'translateY(0) scale(1)', offset: 1 },
      ],
      { duration: t(620), delay: t(delay), easing: EASE, fill: 'both' }
    )
  )
}

function rise(node, delay = 0) {
  if (!node) return null
  return track(
    node.animate([{ opacity: 0, transform: 'translateY(40px)' }, { opacity: 1, transform: 'none' }], {
      duration: t(680),
      delay: t(delay),
      easing: EASE,
      fill: 'both',
    })
  )
}




let stepIndex = 0

const step = () => document.body.dataset.step
const stepAt = (id) => STEP_IDS.indexOf(id)

/**
 * Open a step.
 *
 * Everything about which screen is showing, which dock button is offered and how far along the
 * indicator reads is derived from this one call, so there is exactly one place to look when a
 * step goes to the wrong screen.
 */
function goToStep(id, { animate = true, blob = true } = {}) {
  const i = stepAt(id)
  if (i === -1) return

  // Where the step being left was showing its picture, for the step arriving to fly its own
  // picture out of. Measured now, because a step that is no longer current has no rectangle.
  flightFrom = HERO[step()]?.()?.getBoundingClientRect() ?? null

  stepIndex = i
  document.body.dataset.step = id

  // The dock offers what this step named, and nothing else. A list rather than one name,
  // because the share question has two answers and both belong on the same screen.
  const wanted = new Set(STEPS[i].action)
  for (const btn of DOCK) btn.hidden = !wanted.has(btn.id)

  // Deliberately not `animate`: that switch is about the section's own fade, and step 2 turns
  // it off because the photo's flight is the transition. The blob still has to travel.
  // One section on screen, and it is this one. A class rather than a stylesheet full of
  // `body[data-step=x] .step[data-step=x]` pairs, which is a list that silently stops matching
  // the moment a step is renamed.
  for (const section of document.querySelectorAll('.step')) {
    section.classList.toggle('on', section.dataset.step === id)
  }

  markAt(STEPS[i].mark, { animate: blob })

  setInfo('step', `${i + 1}/${STEPS.length} ${id}`)

  const section = document.querySelector(`.step[data-step="${id}"]`)
  if (section && animate) {
    track(
      section.animate([{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], {
        duration: t(TIMELINE.stepIn),
        easing: EASE,
        fill: 'both',
      })
    )
  }
  STEP_ENTER[id]?.()
}


// Where the blob is currently sitting, in pixels from the left of the bar. Null until the
// first placement, which is what tells the first one not to animate in from nowhere.
let blobAt = null
let blobAnim = null

/** Light one station of the bar, grey everything behind it, and send the blob there. */
function markAt(mark, { animate = true } = {}) {
  ;[...stepBar.children].forEach((dot, n) => {
    dot.classList.toggle('now', n === mark)
    dot.classList.toggle('done', n < mark)
  })
  moveBlob(mark, { animate })
}

/**
 * Move the blob onto station `index`.
 *
 * Squash and stretch rather than a gooey filter. A metaball pinch needs a blurred SVG filter
 * over a repainting element, which is one of the three things that behaves completely
 * differently on the exhibit's Android SoC than it does on a desk; a ball that elongates as it
 * leaves and squashes as it lands reads as liquid just as well and never leaves the compositor.
 *
 * Size and position are measured off the mark itself rather than computed from the column
 * width, so the blob cannot drift if the bar is restyled.
 */
function moveBlob(index, { animate = true } = {}) {
  const mark = stepBar.children[index]?.querySelector('.dot-mark')
  if (!mark) return

  const host = stepsBar.getBoundingClientRect()
  const box = mark.getBoundingClientRect()
  // Not laid out yet — at boot this runs before the first frame. Try again once there is a
  // layout to measure; the ResizeObserver below covers every case after that.
  if (!host.width || !box.width) {
    requestAnimationFrame(() => moveBlob(index, { animate: false }))
    return
  }

  stepBlob.style.width = `${box.width}px`
  stepBlob.style.height = `${box.height}px`
  stepBlob.style.top = `${box.top - host.top}px`

  // Cancel the last trip before writing the new resting place. A finished animation with
  // fill:both keeps painting its final keyframe, and an animation effect outranks inline style
  // — so without this the blob ignores every repositioning after its first journey, which is
  // invisible until the screen changes size and it is left behind over the wrong mark.
  blobAnim?.cancel()
  blobAnim = null

  const from = blobAt
  const to = box.left - host.left
  blobAt = to
  stepBlob.style.transform = `translateX(${to}px)`

  const land = () => {
    ;[...stepBar.children].forEach((d, n) => d.classList.toggle('lit', n === index))
  }

  if (!animate || from === null || Math.abs(to - from) < 1) {
    land()
    return
  }

  // The icon under the blob goes dark only once the blob is over it, so nothing is ever a dark
  // glyph on a dark ground. The one being left goes light immediately, as the blob pulls away.
  ;[...stepBar.children].forEach((d) => d.classList.remove('lit'))

  const d = to - from
  const at = (f, sx, sy) => ({ transform: `translateX(${from + d * f}px) scale(${sx}, ${sy})` })
  blobAnim = track(
    stepBlob.animate(
      [
        { ...at(0, 1, 1), easing: 'cubic-bezier(.55, 0, .85, .45)' },
        { ...at(0.36, 1.62, 0.76), offset: 0.32, easing: 'linear' },
        { ...at(0.88, 1.32, 0.86), offset: 0.66, easing: 'cubic-bezier(.2, .6, .3, 1)' },
        { ...at(1, 0.82, 1.2), offset: 0.86, easing: 'cubic-bezier(.3, 0, .3, 1)' },
        { ...at(1, 1, 1), offset: 1 },
      ],
      { duration: t(TIMELINE.blob), fill: 'both' }
    )
  )
  later(Math.round(t(TIMELINE.blob) * 0.72), land)
}

// A kiosk that is rotated, rescaled or opened at a different size has to find its marks again.
// No animation: a blob sliding because the window changed shape is a bug, not a transition.
new ResizeObserver(() => {
  blobAt = null
  moveBlob(stepIndex, { animate: false })
}).observe(stepsBar)

function setAspect(w, h) {
  if (!w || !h) return
  // On a quarter turn the displayed shape is the camera's, turned — so the ratio flips too.
  const upright = camRot === 90 || camRot === 270
  const ar = upright ? h / w : w / h
  document.documentElement.style.setProperty('--shot-ar', ar.toFixed(4))
}

// The black behind everything.
//
// A display that cannot show every 8-bit level fakes the ones in between by alternating between
// its two nearest, frame after frame — and in the darkest few percent of the range that reads
// as static. #06070a was the worst value available: blue 10 sits exactly halfway between the 8
// and the 12 a 6-bit panel can show, so 60% of the screen alternated 50/50 for ever.
//
// All three of these are levels such a panel can show exactly. Which one a given screen prefers
// is a question about that screen, so it is answered on that screen rather than here.
const GROUNDS = ['#040408', '#000000', '#06070a']
const GROUND_KEY = 'sharedsky.ground'
let groundAt = (() => {
  try {
    const found = GROUNDS.indexOf(localStorage.getItem(GROUND_KEY))
    return found < 0 ? 0 : found
  } catch {
    return 0
  }
})()

function applyGround() {
  document.documentElement.style.setProperty('--bg', GROUNDS[groundAt])
  setInfo('ground', GROUNDS[groundAt] + (groundAt === 2 ? ' - the old one, it shimmers' : ''))
}

function setGround(next) {
  groundAt = ((next % GROUNDS.length) + GROUNDS.length) % GROUNDS.length
  try {
    localStorage.setItem(GROUND_KEY, GROUNDS[groundAt])
  } catch {
    // Not being able to remember it is no reason to refuse to do it.
  }
  applyGround()
}

// The faint sky glow behind everything. Off is a flat black ground — the test for whether the
// banding in the background is what someone is seeing shimmer. ?glow=off, or the debug menu.
// Off by default, which it did not used to be.
//
// It is two very shallow gradients through the near-black range, so most of it lands between
// levels the exhibit panel can display: measured across the four screens, 40–57% of every dark
// pixel needs dithering with it on, against about 1% with it off. On an ordinary monitor it is
// free and rather nice. On that panel it is the single largest source of the red and blue
// speckle, and it came back twice — because it was on by default, and a browser profile that
// gets reset (a kiosk reinstall, cleared storage, a different browser) forgets it was turned off.
// A default is the only setting that survives that.
//
// `?glow=on`, or the debug menu, brings it back for a screen that can hold it still.
const GLOW_KEY = 'sharedsky.glow'
let glowOn = (() => {
  const asked = new URLSearchParams(location.search).get('glow')
  if (asked === 'on') return true
  if (asked === 'off') return false
  try {
    return localStorage.getItem(GLOW_KEY) === 'on'
  } catch {
    return false
  }
})()

function applyGlow() {
  document.body.dataset.glow = glowOn ? 'on' : 'off'
  setInfo('glow', glowOn ? 'on' : 'off - flat background')
}

function setGlow(next) {
  glowOn = next
  try {
    localStorage.setItem(GLOW_KEY, glowOn ? 'on' : 'off')
  } catch {
    // Not being able to remember it is no reason to refuse to do it.
  }
  applyGlow()
}

// ── how much of the live feed to throw away ─────────────────────────────────
//
// A camera bolted to a bracket sees things the exhibit would rather not photograph: the edge of
// its own housing, a fire door, the top of somebody's head at the next exhibit along. Four
// numbers, one per edge, as a percentage of what the viewfinder shows.
//
// The kept window keeps the frame's shape, so trimming one edge trims the opposite axis to
// match. That is what any camera does when its output has a fixed shape — and it is what makes
// the photograph agree with the viewfinder exactly, rather than nearly.
const CROP_KEY = 'sharedsky.crop'
const CROP_MAX = 40 // per edge, %. Past this there is not enough left to stand in.
const EDGES = ['top', 'right', 'bottom', 'left']

let cropAt = (() => {
  const none = { top: 0, right: 0, bottom: 0, left: 0 }
  try {
    const saved = JSON.parse(localStorage.getItem(CROP_KEY) ?? 'null')
    if (!saved || typeof saved !== 'object') return none
    for (const edge of EDGES) {
      const n = Number(saved[edge])
      none[edge] = Number.isFinite(n) ? Math.min(CROP_MAX, Math.max(0, Math.round(n))) : 0
    }
    return none
  } catch {
    // Storage disabled, or somebody put something else under that key.
    return none
  }
})()

/** The kept window, in the terms both the viewfinder and the capture need. */
function cropWindow() {
  const l = cropAt.left / 100
  const r = cropAt.right / 100
  const t0 = cropAt.top / 100
  const b = cropAt.bottom / 100
  return {
    l,
    r,
    t: t0,
    b,
    zoom: Math.max(1 / Math.max(0.2, 1 - l - r), 1 / Math.max(0.2, 1 - t0 - b)),
    cx: (l + 1 - r) / 2,
    cy: (t0 + 1 - b) / 2,
  }
}

function applyCrop() {
  const { zoom, cx, cy } = cropWindow()
  // Rightmost first: the window's middle is brought to the middle of the frame, and then the
  // whole thing is enlarged about that same middle. .live-frame's overflow does the cutting.
  liveCrop.style.transform =
    `scale(${zoom.toFixed(4)}) ` +
    `translate(${((0.5 - cx) * 100).toFixed(3)}%, ${((0.5 - cy) * 100).toFixed(3)}%)`
  const cropped = EDGES.some((edge) => cropAt[edge])
  setInfo('crop', cropped ? EDGES.map((e) => `${e[0]}${cropAt[e]}`).join(' ') + ' %' : 'none')
}

/** Trim one edge, and remember it — the bracket will be in the same place tomorrow. */
function setCrop(edge, value) {
  cropAt[edge] = Math.min(CROP_MAX, Math.max(0, Math.round(value)))
  saveCrop()
}

function clearCrop() {
  for (const edge of EDGES) cropAt[edge] = 0
  saveCrop()
}

function saveCrop() {
  try {
    localStorage.setItem(CROP_KEY, JSON.stringify(cropAt))
  } catch {
    // Not being able to remember it is no reason to refuse to do it.
  }
  applyCrop()
}

/** Push the current rotation into the page: the viewfinder's CSS, the frame's shape, the HUD. */
function applyRotation() {
  document.body.dataset.rot = String(camRot)
  setInfo('rotation', `${camRot}deg`)
  // A quarter turn changes the shape of the window as well as what is drawn in it, so the
  // aspect has to be recomputed rather than merely redrawn.
  setAspect(feed.videoWidth, feed.videoHeight)
}

/** Turn the camera, and remember it — the bracket will still be that way round tomorrow. */
function setRotation(deg) {
  camRot = normRot(deg)
  try {
    localStorage.setItem(ROT_KEY, String(camRot))
  } catch {
    // Not being able to remember it is no reason to refuse to do it.
  }
  applyRotation()
}

/**
 * What the debug menu can do.
 *
 * Registered here rather than declared in perf.js, because these are this screen's own switches
 * and the overlay has no business knowing what a camera rotation is. Actions only, no readouts:
 * facts belong in the HUD, which is already showing them.
 */
function registerDebugActions() {
  addDebugAction({
    label: 'Rotate camera',
    hint: 'quarter turn — viewfinder and capture together, remembered on this machine',
    state: () => `${camRot}°`,
    run: () => setRotation(camRot + 90),
  })
  for (const edge of EDGES) {
    addDebugSlider({
      label: `Crop ${edge}`,
      hint: edge === 'top'
        ? 'trims the live feed and the photograph together; the window keeps the frame\'s shape, so trimming one edge closes in on the other axis to match'
        : undefined,
      min: 0,
      max: CROP_MAX,
      step: 1,
      get: () => cropAt[edge],
      set: (value) => setCrop(edge, value),
      format: (value) => `${value}%`,
    })
  }
  addDebugAction({
    label: 'Clear the crop',
    hint: 'all four edges back to nothing',
    state: () => (EDGES.some((edge) => cropAt[edge]) ? 'cropped' : 'clear'),
    run: () => clearCrop(),
  })
  addDebugAction({
    label: 'Ground',
    hint: 'the black behind everything — if the screen shows static, try the next one',
    state: () => GROUNDS[groundAt],
    run: () => setGround(groundAt + 1),
  })
  addDebugAction({
    label: 'Background glow',
    hint: 'off is a flat black — turn it off to test background banding',
    state: () => (glowOn ? 'on' : 'off'),
    run: () => setGlow(!glowOn),
  })
  addDebugAction({
    label: 'Perf overlay',
    state: () => (perfShowing() ? 'on' : 'off'),
    run: () => togglePerf(),
  })
  addDebugAction({
    label: 'Restart',
    hint: 'back to the camera, keeping nothing',
    run: () => reset(),
  })
}

// ── the photo bay: two stacked canvases, so any change can crossfade ────────

const lutsNow = () => levels.map((l) => levelsLut(l.black, l.white))

// Steps 2 and 4 are the same three controls over two different pictures. Everything that acts
// on "the thing being edited" asks these rather than reaching for `frame` and `levels`, which
// is what lets one draw path and one settling animation serve both.
/** What the drawing path wants: each channel's colour as weights on the three outputs. */
const tints = () => shownHue.map(hueTint)

const editingAstro = () => step() === 'astro'
const activeLevels = () => (editingAstro() ? astroLevels : levels)
const activeFrame = () => (editingAstro() ? pillarsFrame : frame)

/** Draw straight onto whichever canvas is showing — no transition. */
function paint(drawFn) {
  drawFn(front)
}



// ── the levels editors ──────────────────────────────────────────────────────

/** Hand back what the last step's editors were holding. */
function destroyEditors() {
  bigEditors.forEach((e) => e.destroy?.())
  bigEditors = []
}

// A drag can fire pointermove more often than the display can show it, and every one of those
// used to run a full redraw synchronously. Mark what is dirty, draw it once a frame.
let dirtyChannel = -1
let dirtyAll = false
let drawQueued = 0

function queueDraw(index) {
  if (index == null || index < 0) dirtyAll = true
  else if (dirtyChannel === -1) dirtyChannel = index
  else if (dirtyChannel !== index) dirtyAll = true
  if (drawQueued) return
  drawQueued = requestAnimationFrame(runQueuedDraw)
}

function runQueuedDraw() {
  drawQueued = 0
  const only = dirtyAll ? -1 : dirtyChannel
  dirtyChannel = -1
  dirtyAll = false
  if (!activeFrame() || !activeLevels()) return

  count('draws')
  measure('levels', () => {
    bigEditors.forEach((e, i) => (only === -1 || only === i) && e.redraw())
    if (editingAstro()) drawComposite(pillarsCanvas, pillarsFrame, astroLuts())
    else if (step() === 'adjust') drawAdjust()
    else drawUpTo(lit)
  })
}

/** A handle moved: mark it and let the next frame draw it. */
function onLevelsChanged(index) {
  queueDraw(index)
}

/**
 * Introduce the control by using it: slide this channel's handles from the ends of the track
 * to where its light actually is.
 *
 * Two objects visibly travelling is a far stronger cue that they can be moved than any amount
 * of styling, it demonstrates the gesture before the visitor has to guess it, and it leaves
 * them resting inset, where they read as things sitting on a track rather than as the frame
 * around the chart. Tweened in JS rather than with the Web Animations API because every frame
 * has to redraw the histogram and the channel image, not just move a box.
 */
function settleLevels(index) {
  const store = activeLevels()
  const target = activeFrame().rest[index]
  const from = { ...store[index] }
  const g = gen
  const started = performance.now()
  const duration = t(TIMELINE.levelsSettle)

  // Named `tick`, not `step`: a local called `step` would shadow the module's step() and this
  // would silently call itself instead of asking which screen is open.
  const tick = (now) => {
    if (g !== gen) return
    // Taken hold of mid-slide. Leave it exactly where the visitor has put it.
    if (touchedChannels.has(index)) return
    // Left the editing screens mid-slide: land on the target rather than leaving it half moved.
    if (step() !== 'edit' && step() !== 'astro') {
      store[index] = { ...target }
      bigEditors.forEach((e) => e.redraw())
      return
    }
    const p = Math.min(1, (now - started) / duration)
    const e = 1 - (1 - p) ** 5 // an ease-out close enough to the house curve
    store[index] = {
      black: Math.round(from.black + (target.black - from.black) * e),
      white: Math.round(from.white + (target.white - from.white) * e),
    }
    onLevelsChanged(index)
    if (p < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

/**
 * The way in with no keyboard: tap the camera step five times, then the adjust step.
 *
 * Those two are the progress bar's own indicators. They have no behaviour of their own — a tap
 * on one is already a no-op — which is exactly what makes them safe to overload, and what keeps
 * this from taking a press away from anything a visitor might want.
 *
 * The run has to be a run: any other station, or a pause longer than a couple of seconds, puts
 * the count back to nothing. So a visitor idly prodding the bar cannot leave the exhibit armed
 * for whoever touches it next.
 */
const KNOCK_TAPS = 5
const KNOCK_GAP = 2500

function wireDebugKnock() {
  let taps = 0
  let last = 0

  stepsBar.addEventListener('click', (event) => {
    const dot = event.target.closest('.dot')
    if (!dot) return

    const now = performance.now()
    if (now - last > KNOCK_GAP) taps = 0
    last = now

    if (dot.dataset.step === 'camera') {
      taps++
    } else if (dot.dataset.step === 'edit' && taps >= KNOCK_TAPS) {
      taps = 0
      toggleDebug(true)
    } else {
      taps = 0
    }
  })
}

// ── 1. live ─────────────────────────────────────────────────────────────────

async function boot() {
  initPerf()
  registerDebugActions()
  wireDebugKnock()
  loadPillars() // step 4's picture, decoded and split into planes while nobody is watching
  applyRotation()
  applyCrop()
  applyGround()
  applyGlow()

  // Four separate things have to be true for a picture to appear, and when one of them is not,
  // every one of the others still looks fine. So report all four, live:
  //   metadata   videoWidth/Height are 0 until the stream describes itself
  //   decoding   currentTime advancing is the only proof frames are actually arriving
  //   layout     an element with no size shows nothing however well the stream is running
  //   source     a track can be live but muted, which means the camera is delivering nothing
  setProbe('video', () => {
    const box = feed.getBoundingClientRect()
    const track = feed.srcObject?.getVideoTracks?.()[0]
    const state = ['nothing', 'metadata', 'current', 'future', 'enough'][feed.readyState] ?? '?'
    return (
      `${feed.videoWidth}x${feed.videoHeight} ${state} ${feed.paused ? 'PAUSED' : 'playing'} clock ${feed.currentTime.toFixed(1)}s
` +
      `on screen ${Math.round(box.width)}x${Math.round(box.height)}` +
      (track
        ? ` · track ${track.readyState}${track.muted ? ' MUTED(no frames)' : ''}${track.enabled ? '' : ' DISABLED'}`
        : ' · no track')
    )
  })

  // `resize` as well as `loadedmetadata`: Android reports the intrinsic size later than
  // desktop and sometimes changes it again once the stream settles, and the frame is sized
  // from that ratio — so a viewfinder that never gets the second one is a viewfinder with
  // the wrong shape, or none. Attached once, outside the retry, so a recovery cannot stack
  // duplicate listeners.
  feed.addEventListener('loadedmetadata', () => setAspect(feed.videoWidth, feed.videoHeight))
  feed.addEventListener('resize', () => setAspect(feed.videoWidth, feed.videoHeight))

  // ?step=edit opens one step directly, without running the ones before it. That is the whole
  // point of keeping them separable: a step can be worked on without sitting through the piece.
  const jump = new URLSearchParams(location.search).get('step')
  if (jump && STEP_IDS.includes(jump)) {
    setInfo('step jump', jump)
    // It still needs a picture to work on, so take one as soon as the camera is ready.
    openCamera().then(async () => {
      if (jump === 'camera') return
      await wait(400)
      // takePhoto already ends on step 2, so ?step=edit is there once it returns. Calling
      // goToStep again would re-enter edit() and run its whole sequence a second time.
      takePhoto().then(() => jump !== 'edit' && goToStep(jump))
    })
    return
  }

  goToStep('camera', { animate: false })
  openCamera()
}

let camAttempt = 0

/**
 * Open the camera, and keep trying if it will not open.
 *
 * A camera can be unavailable for reasons that have nothing to do with this page and that clear
 * up on their own — another app holding it, or the device's camera service wedged until
 * something releases it. Without this, a fault at 9am is a dead exhibit until somebody notices
 * and reloads, even if the camera freed itself a minute later. Deliberately not on the
 * generation counter that `reset()` bumps: recovery has to outlive a visitor's turn.
 */
async function openCamera() {
  try {
    await startCamera(feed, { want: new URLSearchParams(location.search).get('cam') })
    setAspect(feed.videoWidth, feed.videoHeight)
    $('camError').hidden = true
    shutter.disabled = false
    setInfo('camera error', null)
    if (camAttempt) setInfo('camera', `recovered on attempt ${camAttempt + 1}`)
    camAttempt = 0
  } catch (err) {
    camAttempt++
    showCameraFault(err)
    setTimeout(openCamera, TIMELINE.cameraRetryAt)
  }
}

function showCameraFault(err) {
  shutter.disabled = true
  const box = $('camError')
  box.hidden = false
  // Each of these has a completely different fix, and "no camera" tells whoever is standing
  // in front of the screen none of them. NotReadableError in particular almost always means
  // something else already has the camera, which is a thirty-second fix if you know it.
  const SAID = {
    NotFoundError: 'No camera is connected to this machine.',
    NotReadableError:
      'The camera could not be opened. Another app may be using it — if not, restart the device.',
    TrackStartError:
      'The camera could not be opened. Another app may be using it — if not, restart the device.',
    OverconstrainedError: 'This camera cannot provide the video format the exhibit asked for.',
    NotAllowedError:
      'Camera permission was refused for this address. Clear it in the browser’s site settings and reload.',
    SecurityError:
      'The browser blocked camera access for this address. It needs to be served over https://.',
    AbortError: 'The camera stopped responding while starting up. Reload this page.',
    // The one that produced no message at all before there was a timeout to produce it.
    TimeoutError:
      'The camera did not respond. Still trying — if this does not clear, restart the device.',
  }
  box.replaceChildren(
    err instanceof CameraSetupError ? err.message : (SAID[err.name] ?? `No camera: ${err.message}`)
  )

  // And the technical detail right underneath it, on the screen, not only in the overlay.
  // Whoever is standing in front of a kiosk that will not start has no debugger and often no
  // second machine; a photograph of the screen should be enough to diagnose it. Small and
  // muted, so it reads as a service note rather than as part of the piece.
  const detail = document.createElement('small')
  detail.className = 'err-detail'
  detail.textContent =
    `retrying every ${Math.round(TIMELINE.cameraRetryAt / 1000)}s · attempt ${camAttempt} · ` +
    `${err.name}` +
    ` · ${location.protocol}//${location.host}` +
    ` · secure ${window.isSecureContext}` +
    ` · ${navigator.userAgent.includes('Firefox') ? 'firefox' : 'chromium'}`
  box.append(detail)

  // The visitor-facing line is deliberately gentle. The overlay gets the raw fault, because
  // "no camera" covers a dozen different causes with completely different fixes.
  setInfo('camera error', `${err.name}: ${err.message}`)
  // The overlay is also the only way to see the device list on a tablet, so fill it in even
  // though nothing started.
  reportCameras()
}

// ── the four steps ──────────────────────────────────────────────────────────

/**
 * Each step's hero picture — what the next step's picture flies out of.
 *
 * Read as a step is left, never as one is entered: a step that is no longer current is
 * `display: none` and has no rectangle to measure.
 */
const HERO = {
  camera: () => liveFrame,
  edit: () => photoStack,
  adjust: () => adjustPic,
  confirm: () => confirmPic,
}

/**
 * What each step does when it is opened.
 *
 * Kept as a lookup rather than a chain of calls so that no step knows about any other. That is
 * what lets `?step=astro` work: the step builds whatever it needs and does not care how the
 * visitor got there. Three of the four are sequences rather than screens, and each is written
 * as one async function so that the code reads in the order the visitor sees it.
 */
const STEP_ENTER = {
  camera() {
    shutter.disabled = !feed.videoWidth
  },

  // The photo flies out of the viewfinder into the corner, the sentence types itself
  // underneath, and each chart is carried in on a beam thrown from the word that names it.
  // Nothing to touch here — the adjusting happens on the next screen. This one says what the
  // camera did, and shows it: the photo arrives black and is built up a colour at a time as
  // each colour's name lights, so the picture and the sentence say the same thing at the same
  // moment.
  async edit() {
    if (!frame) return
    clearBeats()
    // Nothing to move on to until the picture has been made. It keeps its place in the dock
    // while it waits, so that revealing it does not resize the dock underneath.
    nextBtn.classList.add('waiting')

    // Black. Not the finished photo — the whole beat is watching it arrive.
    lit = -1
    drawUpTo(-1)

    await flyInto(photoStack, TIMELINE.photoFlight)
    await wait(t(TIMELINE.storyLeadIn))
    await revealStory()
  },

  // Two phases. First the picture they made, carried up to the middle and shown larger than
  // they have yet seen it, and the question. Then the question turns into something they can
  // answer: the picture moves aside and the same three charts come back, with the colour each
  // channel is shown as now the thing that can be changed.
  async adjust() {
    if (!frame) return
    clearBeats()
    submitBtn.classList.add('waiting')
    submitBtn.disabled = false
    drawAdjust()

    await flyInto(adjustPic, TIMELINE.photoFlight)
    await wait(t(TIMELINE.storyLeadIn))
    await fadeIn(adjustStoryEl, ADJUST_STORY)
    if (step() !== 'adjust') return

    // A second for the question to land before the means of answering it appears.
    await wait(t(TIMELINE.askHold))
    if (step() !== 'adjust') return
    await openColours()
  },

  // The picture they made, and the one question in the piece with a wrong answer.
  async confirm() {
    if (!frame) return
    confirmAsk.replaceChildren()
    confirmPic.style.visibility = ''
    yesBtn.disabled = false
    noBtn.disabled = false
    // The answers wait for the question. They are in the dock at the foot of the screen, which
    // is below the text either way, and arriving with it would offer a choice before it has
    // been put.
    yesBtn.classList.add('waiting')
    noBtn.classList.add('waiting')
    drawComposite(confirmCanvas, viewFrame ?? frame, lutsNow(), tints())

    // The wall goes up first, so the picture arrives onto something already moving rather than
    // having a wall appear underneath it afterwards.
    const pool = await loadReelPool()
    if (step() !== 'confirm') return
    stopReels()
    if (pool.length) {
      const deck = [...pool].sort(() => Math.random() - 0.5)
      const each = Math.min(REEL.perReel, Math.max(1, Math.floor(deck.length / 2)))
      fillReel(reelTop, -1, deck.slice(0, each))
      fillReel(reelBottom, 1, deck.slice(each, each * 2))
      startReels()
    } else {
      reelTop.hidden = true
      reelBottom.hidden = true
    }

    await spinInFromLeft(confirmPic, TIMELINE.spin)
    if (step() !== 'confirm') return
    await wait(t(TIMELINE.storyLeadIn))
    await fadeIn(confirmAsk, CONFIRM_ASK)
    if (step() !== 'confirm') return

    yesBtn.classList.remove('waiting')
    noBtn.classList.remove('waiting')
    pop(noBtn)
    pop(yesBtn, 90)
  },

  // Opens blank, on purpose. The line arrives on its own, and only then the famous photo and
  // the same three controls the visitor has just used — in the same arrangement as step 2,
  // because that likeness is the entire argument of the piece.
  async astro() {
    clearBeats()
    resetBtn.classList.add('waiting')
    const alive = () => step() === 'astro'

    await fadeIn(astroLeadEl, ASTRO_LEAD)
    if (!alive()) return
    await wait(t(TIMELINE.astroHold))
    if (!alive()) return

    await showPillars()
    if (!alive()) return

    resetBtn.classList.remove('waiting')
    rise(resetBtn)
    await fadeIn(astroStoryEl, ASTRO_STORY)
  },
}

/** Advance to the next step, or wrap back to the camera from the last one. */
function nextStep() {
  const next = STEPS[stepIndex + 1]
  if (next) goToStep(next.id)
  else reset()
}

// ── 1. camera ───────────────────────────────────────────────────────────────

async function runCountdown() {
  if (!feed.videoWidth || step() !== 'camera') return
  shutter.disabled = true

  for (let n = TIMELINE.countdownFrom; n > 0; n--) {
    countdownEl.textContent = String(n)
    pop(countdownEl)
    await wait(t(TIMELINE.countdownTick))
  }
  countdownEl.textContent = ''
  takePhoto()
}

async function takePhoto() {
  flash.classList.remove('go')
  void flash.offsetWidth
  flash.classList.add('go')

  frame = captureFrame(feed, CAPTURE_EDGE, camRot, cropWindow())
  // What the camera gave and what was kept of it. The one number that says whether a better
  // camera is actually being used, or whether it is being asked for 720p and obliging.
  if (frame) {
    setInfo(
      'capture',
      `camera ${feed.videoWidth}x${feed.videoHeight} -> kept ${frame.width}x${frame.height}` +
        ` (${((frame.width * frame.height) / 1e6).toFixed(1)} MP)`
    )
  }
  if (!frame) {
    shutter.disabled = false
    return
  }

  // Freeze the viewfinder while the photo is handed on; a live frame still moving under a
  // still picture reads as a fault.
  feed.pause()

  // Where each channel's light actually sits. Step 2 has no handles to walk in from the ends of
  // a track any more, so the picture opens on its own range and step 3 takes it from there.
  levels = CHANNELS.map((_, i) => ({ ...frame.rest[i] }))
  // The histograms and resting points come from the full capture; everything that redraws on
  // every pointermove works on this copy instead.
  viewFrame = downscaleFrame(frame, VIEW_EDGE)
  thumbFrame = downscaleFrame(frame, THUMB_EDGE)
  // The *camera's* dimensions, not the frame's: captureFrame has already applied the rotation
  // to the frame, and setAspect applies it again — feeding it the rotated size inverts the
  // aspect ratio for every screen after this one.
  setAspect(feed.videoWidth, feed.videoHeight)

  await wait(t(TIMELINE.freezeHold))
  // No section fade for this one — the photo's own flight is the transition, and a fade
  // underneath it would be a second animation saying the same thing more weakly.
  goToStep('edit', { animate: false })
}

// ── 2. the sentence and the picture, together ───────────────────────────────

/**
 * The sentence step 2 shows, as segments rather than as a string with markup in it.
 *
 * A segment with a `ch` is a channel's name. It arrives white with the rest of the sentence and
 * lights later, in turn — and the word taking its colour is the same moment that colour appears
 * in the photograph, which is the only reason the sentence is broken up like this.
 */
const STORY = [
  { text: 'When you took a photo, the camera captured light. That light got sorted into ' },
  { ch: 0 },
  { text: ', then ' },
  { ch: 1 },
  { text: ', and then ' },
  { ch: 2 },
  { text: '.' },
]

const STORY_AFTER = [
  { text: 'In an instant, the camera combines these colors. ' },
  { block: true, text: 'The result is an image that approximates what you see with your eyes. Is this image real?' },
]

const ADJUST_STORY = [
  { text: 'You used the camera to capture real data, just like an astrophotographer.' },
  { block: true, text: 'Try changing the colors. Is this image still real?' },
  { block: true, text: 'Astrophotographers isolate colors in a similar way to focus on specific objects.' },
]

const CONFIRM_ASK = [{ text: 'Would you like to share your sky to the gallery?' }]

const ASTRO_LEAD = [
  { text: 'Your image was shared and is now part of the gallery! Take a look at this famous photo:' },
]

const ASTRO_STORY = [
  {
    text:
      'Astrophotographers use filters to look only at light coming from specific objects. ' +
      'Then, they give that light color so you can see the objects all together in a picture.',
  },
]

/** How many channels are currently in the picture. -1 is black; 2 is all three. */
let lit = -1

/**
 * Put a line on screen, whole, and fade it in.
 *
 * It used to be typed a character at a time. Reading speed is not typing speed, and a visitor
 * who has finished the line is left watching the rest of it arrive — so the line arrives at
 * once and the *beats* carry the pacing instead.
 */
function fadeIn(el, segments, ms = TIMELINE.blockFade) {
  el.replaceChildren(
    ...segments.map((seg) => {
      const span = document.createElement('span')
      span.textContent = seg.text ?? CHANNELS[seg.ch].label
      if (seg.ch != null) {
        span.className = 'w-ch'
        span.style.setProperty('--acc', CHANNELS[seg.ch].accent)
        span.dataset.ch = seg.ch
      }
      if (seg.block) span.className = 'story-line'
      return span
    })
  )
  return track(
    el.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: t(ms),
      easing: 'linear',
      fill: 'both',
    })
  ).finished.catch(() => {})
}

/** The picture with the first `n + 1` channels in it, and nothing else. */
function drawUpTo(n) {
  if (!frame || !levels) return
  const luts = levels.map((l, i) => (i <= n ? levelsLut(l.black, l.white) : ZERO_LUT))
  paint((c) => drawComposite(c, viewFrame ?? frame, luts, tints()))
}

/**
 * One channel on its own, in its own colour.
 *
 * The same composite with the other two switched off, rather than a separate drawing path —
 * so a layer beside the picture is provably a part of the picture and not an approximation of
 * one, and there is one place to change if the colours ever move.
 */
function drawLayer(index, canvas = chanLayers.querySelector(`[data-ch="${index}"] .chan-img`)) {
  if (!canvas || !thumbFrame || !levels) return
  const only = levels.map((l, i) => (i === index ? levelsLut(l.black, l.white) : ZERO_LUT))
  drawComposite(canvas, thumbFrame, only, tints())
}

/**
 * Send a copy of one layer into the frame, and leave its colour there.
 *
 * A copy, not the layer itself: the three stay where they are, so what the visitor watches is
 * the picture being *assembled from* them rather than them being used up. The composite only
 * gains the channel when the copy lands, so the frame and the flight agree.
 */
async function flyLayerIn(index) {
  const source = chanLayers.querySelector(`[data-ch="${index}"]`)
  if (!source || !thumbFrame) return

  const host = fliers.getBoundingClientRect()
  const from = source.getBoundingClientRect()
  const to = photoStack.getBoundingClientRect()
  if (!from.width || !to.width) return

  const flier = document.createElement('canvas')
  flier.className = 'flier'
  drawLayer(index, flier)
  flier.style.left = `${from.left - host.left}px`
  flier.style.top = `${from.top - host.top}px`
  flier.style.width = `${from.width}px`
  flier.style.height = `${from.height}px`
  fliers.append(flier)

  const anim = track(
    flier.animate(
      [
        { transform: 'none' },
        {
          transform:
            `translate(${to.left - from.left}px, ${to.top - from.top}px) ` +
            `scale(${to.width / from.width}, ${to.height / from.height})`,
        },
      ],
      { duration: t(TIMELINE.fly), easing: EASE, fill: 'both' }
    )
  )
  await anim.finished.catch(() => {})

  // The colour arrives in the frame and the copy goes, in that order — swapped, the frame
  // flickers black for a frame between the two.
  lit = index
  drawUpTo(index)
  flier.remove()
}

/**
 * The whole of step 2: the sentence, then each colour in turn, then the summary.
 *
 * Both paragraphs end up on screen together. The second one used to wait for somebody to drag a
 * chart, and there are no charts here any more — waiting for a gesture that cannot happen would
 * simply have left it invisible.
 */
async function revealStory() {
  const alive = () => step() === 'edit'
  await fadeIn(storyEl, STORY)
  await wait(t(TIMELINE.readHold))

  for (let i = 0; i < CHANNELS.length; i++) {
    if (!alive()) return
    storyEl.querySelector(`.w-ch[data-ch="${i}"]`)?.classList.add('lit')
    // The frame stays empty through all of this. The three colours are being taken *apart* here;
    // putting them back together is the next paragraph's job, and doing both at once left
    // nothing for the second half of the screen to say.
    drawLayer(i)
    chanLayers.querySelector(`[data-ch="${i}"]`)?.classList.add('in')
    await wait(t(TIMELINE.channelStep))
  }
  if (!alive()) return

  await wait(t(TIMELINE.afterGap))
  if (!alive()) return
  await fadeIn(storyAfterEl, STORY_AFTER)
  await wait(t(TIMELINE.assembleWait))

  // ...and now the sentence is acted out: each layer sends a copy of itself into the frame, and
  // the picture is built out of the three the visitor has just been shown.
  for (let i = 0; i < CHANNELS.length; i++) {
    if (!alive()) return
    await flyLayerIn(i)
    await wait(t(TIMELINE.flyGap))
  }
  if (!alive()) return

  nextBtn.classList.remove('waiting')
  pop(nextBtn)
}

/** Put every step that says something back to the empty screen it starts from. */
function clearBeats() {
  ;[storyEl, storyAfterEl, adjustStoryEl, confirmAsk, astroLeadEl, astroStoryEl].forEach((el) =>
    el.replaceChildren()
  )
  document.querySelectorAll('.channel, .chan-layer').forEach((el) => el.classList.remove('in'))
  slidersTitle.classList.remove('in')
  ;[nextBtn, submitBtn, yesBtn, noBtn, resetBtn].forEach((b) => b.classList.remove('waiting'))
  stopReels()
  confirmPic.style.visibility = ''
  fliers.replaceChildren()
  astroSplit.hidden = true
  adjustSplit.dataset.phase = 'ask'
  shownHue = CHANNELS.map((c) => c.hue)
  recoloured = false
  touchedChannels.clear()
  lit = -1
}

/**
 * Animate an element from where it used to be to where it now is.
 *
 * FLIP: the element is already at its final size in its final place, and what is animated is
 * the difference. Animating width and position instead relayouts everything around it on every
 * frame.
 */
function flipTo(el, from, ms) {
  const to = el.getBoundingClientRect()
  if (!from || !from.width || !to.width) {
    rise(el) // nothing to fly from: ?step= opened this directly. Give it an entrance of its own.
    return wait(Math.round(t(ms) * 0.5))
  }

  const anim = track(
    el.animate(
      [
        {
          transformOrigin: 'top left',
          transform:
            `translate(${from.left - to.left}px, ${from.top - to.top}px) ` +
            `scale(${from.width / to.width}, ${from.height / to.height})`,
        },
        { transformOrigin: 'top left', transform: 'none' },
      ],
      { duration: t(ms), easing: EASE, fill: 'both' }
    )
  )
  return anim.finished.catch(() => {})
}

// ── two strips of the wall, behind the question ───────────────────────────────
//
// The share question is easier to answer with the thing it is about already on screen, so the
// curated pictures run past above and below it — the top strip leftwards, the bottom strip
// rightwards. Say yes and a space opens in one of them for the visitor's own.
//
// They come from api/gallery/all, which claims nothing. Joining the register the way a real
// gallery screen does would put the tablet on the wall as an extra screen and hold a hand of
// pictures the monitors could then not show.

const REEL = {
  perReel: 9, // distinct pictures in each strip
  speed: 38, // px per second at rest
  gap: 10, // px between prints; matches .reel-tile's margin
}

/** The curated folder, fetched once. An empty answer is a fine answer: the strips hide. */
let reelPool = null
async function loadReelPool() {
  if (reelPool) return reelPool
  try {
    const res = await fetch('api/gallery/all')
    const body = await res.json()
    reelPool = Array.isArray(body.pictures) ? body.pictures : []
  } catch {
    // No server, or no folder. The question still works; it just asks it on a bare screen.
    reelPool = []
  }
  setInfo('reels', `${reelPool.length} curated`)
  return reelPool
}

const reels = []
const shotAr = () =>
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--shot-ar')) || 1.3333

/** Lay a strip out. `dir` is -1 for one that runs left, +1 for one that runs right. */
function fillReel(el, dir, pics) {
  const strip = el.querySelector('.reel-track')
  strip.replaceChildren()
  if (!pics.length) {
    el.hidden = true
    return
  }
  el.hidden = false

  // Laid down twice. The loop runs the length of one pass and then jumps back, and with two
  // identical passes that jump lands on the same pixels — which is what makes it seamless.
  for (let pass = 0; pass < 2; pass++) {
    for (const pic of pics) {
      const tile = document.createElement('div')
      tile.className = 'reel-tile'
      // The shape comes from the manifest, so the strip has its true width before a single
      // picture has loaded. Measured after, the loop would be measured against an empty row.
      tile.style.aspectRatio = String(pic.ar || 1.5)
      const img = document.createElement('img')
      img.src = pic.src
      img.alt = ''
      img.decoding = 'async'
      tile.append(img)
      strip.append(tile)
    }
  }
  reels.push({ el, strip, dir, anim: null })
}

/** Set both strips running. Each plays forwards; the keyframes carry the direction. */
function startReels() {
  for (const reel of reels) {
    const half = reel.strip.scrollWidth / 2
    if (!half) continue
    const from = reel.dir < 0 ? 0 : -half
    const to = reel.dir < 0 ? -half : 0
    reel.anim = reel.strip.animate(
      [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }],
      { duration: (half / REEL.speed) * 1000, iterations: Infinity, easing: 'linear' }
    )
    if (STILL) reel.anim.pause()
  }
}

function stopReels() {
  for (const reel of reels) reel.anim?.cancel()
  reels.length = 0
  for (const el of [reelTop, reelBottom]) {
    el.hidden = false
    el.querySelector('.reel-track')?.replaceChildren()
  }
}

/**
 * Ease every strip's speed to whatever `targetFor` asks of it.
 *
 * Only ever towards zero, and never past it: an animation with infinite iterations played at a
 * negative rate walks its clock back past the start and simply stops there. Reversing a strip
 * is done by giving it new keyframes, in zoomReelsRight.
 */
function rampReels(targetFor, ms) {
  const live = reels.filter((r) => r.anim)
  if (!live.length || STILL) return Promise.resolve()

  const from = live.map((r) => r.anim.playbackRate)
  const to = live.map((r) => targetFor(r))
  const span = Math.max(1, t(ms))
  const t0 = performance.now()

  return new Promise((done) => {
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / span)
      const eased = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2
      live.forEach((r, i) => {
        r.anim.playbackRate = from[i] + (to[i] - from[i]) * eased
      })
      if (p < 1) requestAnimationFrame(tick)
      else done()
    }
    requestAnimationFrame(tick)
  })
}

/**
 * Both strips away to the right, accelerating.
 *
 * A fresh animation per strip rather than a change of rate, because one of them was running
 * the other way and reversing an infinite animation stalls it. Each starts from exactly where
 * its strip is standing, and the read and the replacement happen in the same task, so the
 * cancel never paints.
 */
function zoomReelsRight(ms) {
  const travel = innerWidth * 2.4
  for (const reel of reels) {
    const at = new DOMMatrix(getComputedStyle(reel.strip).transform).e
    reel.anim?.cancel()
    reel.anim = reel.strip.animate(
      [{ transform: `translateX(${at}px)` }, { transform: `translateX(${at + travel}px)` }],
      { duration: t(ms), easing: 'cubic-bezier(.45, 0, .7, .4)', fill: 'both' }
    )
  }
}

/** The picture turns down out of the middle of the screen and into a space in one strip. */
function spinIntoGap(el, to, ms) {
  const from = el.getBoundingClientRect()
  if (!from.width || !to.width) return null
  const scale = to.width / from.width
  const dx = to.left + to.width / 2 - (from.left + from.width / 2)
  const dy = to.top + to.height / 2 - (from.top + from.height / 2)

  return track(
    el.animate(
      [
        { transform: 'none', offset: 0 },
        {
          transform: `translate(${dx}px, ${dy}px) rotate(360deg) scale(${scale})`,
          offset: 1,
        },
      ],
      { duration: t(ms), easing: 'cubic-bezier(.32, .78, .22, 1)', fill: 'both' }
    )
  )
}

/**
 * Yes, with a wall to join.
 *
 * The strips stop, a space opens somewhere a visitor can see it, the picture turns into that
 * space, and then the whole wall runs off to the right. Returns false if there is no wall —
 * an empty img/sky/ folder, or no server — and the caller falls back to the plain exit.
 */
async function joinTheWall(el) {
  const live = reels.filter((r) => r.anim && !r.el.hidden)
  if (!live.length || !frame) return false

  await rampReels(() => 0, TIMELINE.reelStop)
  if (step() !== 'confirm') return true

  const reel = live[Math.floor(Math.random() * live.length)]
  const tiles = [...reel.strip.children]
  // Somewhere it can actually be watched opening, rather than off the edge of the screen.
  const onScreen = tiles.filter((tile) => {
    const box = tile.getBoundingClientRect()
    return box.right > innerWidth * 0.12 && box.left < innerWidth * 0.88
  })
  const before = onScreen.length
    ? onScreen[Math.floor(Math.random() * onScreen.length)]
    : tiles[0]

  const width = reel.el.clientHeight * shotAr()
  const gap = document.createElement('div')
  gap.className = 'reel-tile reel-gap'
  gap.style.width = '0px'
  gap.style.marginInlineEnd = '0px'
  reel.strip.insertBefore(gap, before)

  const opening = gap.animate(
    [
      { width: '0px', marginInlineEnd: '0px' },
      { width: `${width}px`, marginInlineEnd: `${REEL.gap}px` },
    ],
    { duration: t(TIMELINE.reelGapOpen), easing: EASE, fill: 'both' }
  )
  await opening.finished.catch(() => {})
  // Held open by style, not by a finished animation: a filled animation outranks inline style,
  // and what lands here next needs the box to be real rather than merely painted.
  opening.cancel()
  gap.style.width = `${width}px`
  gap.style.marginInlineEnd = `${REEL.gap}px`
  if (step() !== 'confirm') return true

  const flight = spinIntoGap(el, gap.getBoundingClientRect(), TIMELINE.reelJoin)
  await flight?.finished.catch(() => {})
  if (step() !== 'confirm') return true

  // The picture appears in the strip and the flying one goes, in that order and in the same
  // task, so there is never a frame showing both or neither.
  const print = document.createElement('canvas')
  drawComposite(print, thumbFrame ?? viewFrame ?? frame, lutsNow(), tints())
  gap.append(print)
  gap.classList.remove('reel-gap')
  flight?.cancel()
  el.style.visibility = 'hidden'

  await wait(t(TIMELINE.reelSettle))
  if (step() !== 'confirm') return true
  zoomReelsRight(TIMELINE.reelZoom)
  await wait(Math.round(t(TIMELINE.reelZoom) * 0.75))
  return true
}

/**
 * The picture pulls out of shape on the screen being left, and holds there.
 *
 * The anchor is the bottom right corner, so the top left is the one that travels. Nothing
 * cancels it here: the caller changes step in the same task, so the snap back never paints.
 */
async function stretchAway(el, ms) {
  const grow = track(
    el.animate(
      [
        { transformOrigin: '100% 100%', transform: 'none' },
        { transformOrigin: '100% 100%', transform: 'scale(1.16)' },
      ],
      { duration: t(ms), easing: 'cubic-bezier(.34, 1.06, .48, 1)', fill: 'both' }
    )
  )
  await grow.finished.catch(() => {})
  await wait(t(TIMELINE.stretchHold))
  grow.cancel()
}

/**
 * ...and arrives spinning, in from the left, landing in the middle of the new screen.
 *
 * The distance is measured from the picture's own box rather than being a fixed number, so it
 * starts off the edge of the screen whatever shape the photograph turned out to be. Opacity is
 * up by a fifth of the way in: a picture that fades in over the whole flight never reads as
 * having travelled, it reads as having appeared.
 */
async function spinInFromLeft(el, ms) {
  const box = el.getBoundingClientRect()
  const from = -(box.right + box.width * 0.2)

  const anim = track(
    el.animate(
      [
        { transform: `translateX(${from}px) rotate(-330deg) scale(.45)`, opacity: 0, offset: 0 },
        { opacity: 1, offset: 0.22 },
        { transform: 'translateX(0) rotate(0deg) scale(1)', opacity: 1, offset: 1 },
      ],
      { duration: t(ms), easing: 'cubic-bezier(.16, .82, .24, 1)', fill: 'both' }
    )
  )
  await anim.finished.catch(() => {})
  anim.cancel()
}

/** Yes: away to the right, turning, off the edge. */
async function spinAwayRight(el, ms) {
  const box = el.getBoundingClientRect()
  const to = innerWidth - box.left + box.width * 0.2

  const anim = track(
    el.animate(
      [
        { transform: 'none', opacity: 1, offset: 0 },
        { opacity: 1, offset: 0.72 },
        { transform: `translateX(${to}px) rotate(330deg) scale(.45)`, opacity: 0, offset: 1 },
      ],
      { duration: t(ms), easing: 'cubic-bezier(.45, 0, .7, .45)', fill: 'both' }
    )
  )
  await anim.finished.catch(() => {})
  anim.cancel()
}

/**
 * No: it falls.
 *
 * Not a drop — a feather. No acceleration, because gravity is the wrong feeling for a picture
 * being let go of; and the sway and the tilt are given different rhythms so the two never line
 * up into something mechanical. The ease between each pair of keyframes does the rest: it
 * slows at the end of every swing, which is what a falling leaf actually does.
 */
async function featherDown(el, ms) {
  const box = el.getBoundingClientRect()
  const drop = innerHeight - box.top + box.height * 0.2
  const sway = Math.max(24, box.width * 0.085)

  const anim = track(
    el.animate(
      [
        { transform: 'translate(0, 0) rotate(0deg)', opacity: 1, offset: 0 },
        { transform: `translate(${-sway}px, ${drop * 0.22}px) rotate(-8deg)`, opacity: 1, offset: 0.24 },
        { transform: `translate(${sway * 0.92}px, ${drop * 0.47}px) rotate(7deg)`, opacity: 1, offset: 0.5 },
        { transform: `translate(${-sway * 0.66}px, ${drop * 0.73}px) rotate(-5.5deg)`, opacity: 1, offset: 0.76 },
        { transform: `translate(${sway * 0.4}px, ${drop}px) rotate(4deg)`, opacity: 0, offset: 1 },
      ],
      { duration: t(ms), easing: 'ease-in-out', fill: 'both' }
    )
  )
  await anim.finished.catch(() => {})
  anim.cancel()
}

/** The same, out of wherever the step we have just left was showing its picture. */
function flyInto(el, ms) {
  const from = flightFrom
  flightFrom = null
  return flipTo(el, from, ms)
}

// ── 2 and 4. the charts ─────────────────────────────────────────────────────

/**
 * Build one levels chart per channel into whichever step is asking.
 *
 * Steps 2 and 4 are the same component over two different pictures: `source` supplies the
 * histograms, `store` is the array the handles write into. Passing both rather than reaching
 * for module state is what keeps the visitor's own levels and the famous photo's separate —
 * adjusting the nebula cannot quietly rewrite the picture they have already shared.
 */
function buildEditors(host, source, store, { onFirstTouch, hueFor } = {}) {
  destroyEditors()
  host.querySelectorAll('.channel-editor').forEach((el) => el.replaceChildren())

  CHANNELS.forEach((_, i) => {
    bigEditors.push(
      createLevels({
        mount: host.querySelector(`[data-ch="${i}"] .channel-editor`),
        channelIndex: i,
        bins: source.histograms[i],
        get: () => store[i],
        set: (next) => (store[i] = next),
        compact: true,
        onInput: onLevelsChanged,
        onFirstTouch,
        hue: hueFor?.(i) ?? null,
      })
    )
  })
}

// ── 3. share ────────────────────────────────────────────────────────────────

/** The picture as it currently stands, colours and all. */
function drawAdjust() {
  if (frame) drawComposite(adjustCanvas, viewFrame ?? frame, lutsNow(), tints())
}

/**
 * Hand the controls back, with the colours now loose.
 *
 * The same three charts over the same three sets of numbers as step 2 — the black and white
 * points are still theirs to move — but each chart has gained three swatches, and the colour a
 * channel's light is shown as is now something the visitor chooses. Which is the whole of what
 * an astrophotographer does to a filtered exposure, and the reason the question above is worth
 * asking twice.
 */
async function openColours() {
  buildEditors(adjustChannels, frame, levels, {
    hueFor: (i) => ({ get: () => shownHue[i], set: (deg) => pickHue(i, deg) }),
  })

  // Fade the question out, move the picture aside, and bring the question back beside the
  // controls it now refers to. The text is cross-faded rather than flown: it changes size and
  // wrapping width between the two phases, and scaling a paragraph through that is a smear.
  const picFrom = adjustPic.getBoundingClientRect()
  const out = track(
    adjustStoryEl.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: t(200),
      easing: 'linear',
      fill: 'both',
    })
  )
  await out.finished.catch(() => {})
  if (step() !== 'adjust') return

  adjustSplit.dataset.phase = 'tune'
  flipTo(adjustPic, picFrom, TIMELINE.phaseSwap)
  out.cancel()
  track(
    adjustStoryEl.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: t(320),
      delay: t(TIMELINE.phaseSwap * 0.4),
      easing: 'linear',
      fill: 'both',
    })
  )

  await wait(t(TIMELINE.phaseSwap * 0.55))
  slidersTitle.classList.add('in')
  for (let i = 0; i < CHANNELS.length; i++) {
    if (step() !== 'adjust') return
    adjustChannels.querySelector(`[data-ch="${i}"]`).classList.add('in')
    await wait(t(TIMELINE.astroChartIn))
  }
  // The handles are not asking for attention here — they have already been used, and the
  // swatches are the new thing. Two invitations at once is neither.
  bigEditors.forEach((e) => e.setAsking(true))
}

/**
 * Give one channel's light a different colour.
 *
 * Free, not a trade. Two channels can be given the same colour and the picture is still a
 * picture, because the composite adds them rather than slotting them — which is also the honest
 * version of what a narrowband image is, and the reason the strip is a spectrum rather than
 * three buttons. Moving far enough from where the marker sits is the point of the exercise.
 */
function pickHue(src, deg) {
  if (shownHue[src] === deg) return
  shownHue[src] = deg

  // The button appears once they have actually moved a colour off its own hue, not merely
  // touched the strip — landing back where you started has not answered the question.
  if (!recoloured && deg !== CHANNELS[src].hue) {
    recoloured = true
    submitBtn.classList.remove('waiting')
    pop(submitBtn)
    bigEditors.forEach((e) => e.setAsking(false))
  }

  queueDraw(src)
}

/** "Share my sky" no longer shares anything — it asks. */
async function onSubmit() {
  if (step() !== 'adjust') return
  submitBtn.disabled = true
  // The picture leaves this screen before the next one has it: it stretches, holds, and the
  // spin onto the question is the release of that hold.
  await stretchAway(adjustPic, TIMELINE.stretch)
  submitBtn.disabled = false
  goToStep('confirm')
}

/**
 * Yes.
 *
 * Deliberately not awaited. A visitor pressing Yes must never wait on a network, and never has
 * to: the store keeps the picture on this device if the wall cannot be reached, so the turn
 * carries on either way. Where it actually went goes to the debug overlay, because that is a
 * question for whoever is running the exhibit and not for the person standing here.
 */
async function onYes() {
  if (step() !== 'confirm') return
  yesBtn.disabled = true
  noBtn.disabled = true

  publishToWall({
    image: compositeURL(frame, lutsNow(), tints()),
    levels: levels.map((l) => ({ ...l })),
    shownHue: [...shownHue],
  }).then(
    (r) => setInfo('shared', r.kept === 'wall' ? 'to the wall' : `${r.kept} — ${r.why}`),
    (err) => setInfo('shared', `failed: ${err.message}`)
  )

  // Into a space on the wall if there is a wall; off to the side if the folder is empty.
  const joined = await joinTheWall(confirmPic)
  if (!joined) await spinAwayRight(confirmPic, TIMELINE.spinOut)
  goToStep('astro')
}

/**
 * No.
 *
 * The picture falls rather than cutting away. It is the one moment in the piece where something
 * a visitor made is discarded, and letting it go quietly is worth the two and a half seconds.
 */
async function onNo() {
  if (step() !== 'confirm') return
  yesBtn.disabled = true
  noBtn.disabled = true
  await featherDown(confirmPic, TIMELINE.feather)
  reset()
}

// ── 4. the famous photo ─────────────────────────────────────────────────────

const astroLuts = () => astroLevels.map((l) => levelsLut(l.black, l.white))

/**
 * Load the nebula and take it apart into channels.
 *
 * Started at boot, awaited on step 4. Decoding a megapixel and splitting it into three planes
 * takes long enough on the exhibit tablet to be visible, and the one moment it must not be
 * visible is while a visitor is watching an empty screen waiting for it.
 */
function loadPillars() {
  if (pillarsReady) return pillarsReady

  pillarsReady = new Promise((resolve) => {
    if (pillarsSrc.complete && pillarsSrc.naturalWidth) return resolve()
    pillarsSrc.addEventListener('load', resolve, { once: true })
    pillarsSrc.addEventListener('error', resolve, { once: true })
  }).then(() => {
    if (!pillarsSrc.naturalWidth) {
      setInfo('pillars', `did not load: ${pillarsSrc.getAttribute('src')}`)
      return null
    }
    // It is not the shape of the camera in the room, so it carries its own ratio.
    document.documentElement.style.setProperty(
      '--pillars-ar',
      (pillarsSrc.naturalWidth / pillarsSrc.naturalHeight).toFixed(4)
    )
    pillarsFrame = frameFromImage(pillarsSrc, PILLARS_EDGE)
    setInfo('pillars', `${pillarsFrame.width}x${pillarsFrame.height}`)
    return pillarsFrame
  })
  return pillarsReady
}

/** Bring in the nebula and its three controls, in step 2's arrangement. */
async function showPillars() {
  const pic = await loadPillars()
  // Without the picture there is nothing to adjust, but the sentence is still worth saying —
  // so this returns quietly rather than leaving the visitor on a screen that never finishes.
  if (!pic || step() !== 'astro') return

  astroLevels = CHANNELS.map(() => ({ black: 0, white: 255 }))
  buildEditors(astroChannels, pic, astroLevels)
  drawComposite(pillarsCanvas, pic, astroLuts())

  // The line slides up to make room rather than jumping there.
  const leadFrom = astroLeadEl.getBoundingClientRect()
  astroSplit.hidden = false
  flipTo(astroLeadEl, leadFrom, TIMELINE.astroPicIn)

  rise(pillarsPic)
  await wait(t(TIMELINE.astroPicIn))

  // One chart at a time, each sliding its handles in off the ends of the track — the same
  // introduction they were given on step 2, minus the beams, which have already said their bit.
  for (let i = 0; i < CHANNELS.length; i++) {
    astroChannels.querySelector(`[data-ch="${i}"]`).classList.add('in')
    settleLevels(i)
    await wait(t(TIMELINE.astroChartIn))
  }
  bigEditors.forEach((e) => e.setPulsing(true))
}

// ── reset ───────────────────────────────────────────────────────────────────

function reset() {
  cancelAll()

  frame = null
  viewFrame = null
  thumbFrame = null
  levels = null
  astroLevels = null
  destroyEditors()
  clearBeats()
  document.querySelectorAll('.channel-editor').forEach((el) => el.replaceChildren())

  // Undo anything left on the elements that outlive a visitor. `pillarsFrame` deliberately
  // survives: it is the same picture for every visitor and costs a second to rebuild.
  front = photoA
  feed.play().catch(() => {}) // takePhoto() paused it for the hand-off
  countdownEl.textContent = ''
  submitBtn.disabled = false
  ;[
    photoA, photoB, adjustCanvas, confirmCanvas, pillarsCanvas,
    ...chanLayers.querySelectorAll('.chan-img'),
  ].forEach((c) => c.getContext('2d').clearRect(0, 0, c.width, c.height))

  // A hard cut, blob included: "Start again" is not a transition, it is the piece ending.
  goToStep('camera', { animate: false, blob: false })
  setAspect(feed.videoWidth, feed.videoHeight)
  shutter.disabled = !feed.videoWidth
}

// ── wiring ──────────────────────────────────────────────────────────────────

// Hand the camera back before the page goes away.
//
// Nothing else does. On a reload the browser is supposed to release it when the old document
// is torn down, but that is a race the new document can lose — and losing it means the fresh
// page asks for a camera the dying one still holds, and gets nothing. `pagehide` rather than
// `beforeunload`, which mobile browsers frequently decline to fire.
addEventListener('pagehide', () => {
  feed.srcObject?.getTracks?.().forEach((t) => t.stop())
})

shutter.addEventListener('click', runCountdown)
nextBtn.addEventListener('click', nextStep)
submitBtn.addEventListener('click', onSubmit)
yesBtn.addEventListener('click', onYes)
// No keeps nothing: the picture is never published, and the next visitor starts clean.
noBtn.addEventListener('click', onNo)
resetBtn.addEventListener('click', reset)

boot()
