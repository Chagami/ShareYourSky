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

import { startCamera, CameraSetupError, reportCameras, sizeFor } from './camera.js'
import {
  CHANNELS, captureFrame, frameFromImage, downscaleFrame, levelsLut, hueTint, ZERO_LUT,
  stackFrames, denoiseFrame, ensureStats, levelsGain,
  drawComposite, compositeURL,
} from './imaging.js'
import { createLevels } from './levels.js'
import { createFrameGuard } from './frameguard.js'
import { createLiveDenoise, LIVE_MODES } from './livedenoise.js'
import {
  initPerf,
  measure,
  count,
  setProbe,
  setInfo,
  addDebugAction,
  addDebugSlider,
  toggleDebug,
  refreshDebug,
  toggle as togglePerf,
  showing as perfShowing,
} from './perf.js'
import { publish as publishToWall } from './store.js'
import shutterSoundUrl from '../audio/camera-shutter.mp3'

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

  // ...and a share, when there is. The strip stops, a space opens, the picture turns into it.
  reelStop: 460, // the strip easing to a halt
  reelGapOpen: 540, // a space opening in one of them
  reelJoin: 1150, // the picture turning down into that space
  reelSettle: 480, // a beat with it sitting there, one of the wall
  reelZoom: 950, // and the strip away to the right

  // Step 3, which asks its question and then hands back the controls.
  phaseSwap: 720, // the picture moving aside to make room for the charts

  // Step 4, which opens on an empty screen.
  realityHold: 1200, // the line about the room, read before its answers arrive
  chartIn: 420, // between one chart arriving and the next, on either screen that has them


  cameraRetryAt: 15000, // a camera that will not open is retried until it does
}

// Longest edge, not width — see captureFrame. The camera is asked for 4K, and this is what is
// kept of it: about 3.8 megapixels, four times what the old 1280x720 request produced. The cap
// exists because the whole cost of a bigger picture lands in one place — the JPEG written when
// a visitor shares — and beyond this it becomes a pause they can see.
const CAPTURE_EDGE = 2600

// What every redraw works on while the sliders move, so this is the one number here with a
// per-frame cost. 1600 on the longest edge is 1200 across for an upright photo, which covers
// the ~1100px the picture is actually shown at on the kiosk — under that it was being upscaled
// on screen, which is its own kind of soft.
const VIEW_EDGE = 1600
// The three channel layers beside it are a fifth of the width and never redraw, so they can be
// a fifth of the pixels.
const THUMB_EDGE = 340
// What a visitor's picture is kept at once it is shared — on the wall and in the archive. The
// wall draws a print at most about 900 pixels across on a 1080p screen (fitted into 46% of its
// width), so 1200 is that with room to spare. The screens are Raspberry Pis, and the
// whole 2600-pixel capture cost each of them some 15MB of decoded picture, for detail nobody can
// see from across a room. Shrunk as planes, the same box average every smaller copy uses.
const WALL_EDGE = 1200

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

// Flips, on top of the rotation: left to right and top to bottom, as the picture is seen on
// screen. Like the rotation, a fact about one camera on one bracket, so set from the debug menu
// and remembered on the machine. Both the viewfinder and the photograph take them.
const FLIP_KEY = 'sharedsky.flip'
const flipAt = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(FLIP_KEY) ?? 'null')
    return { x: saved?.x === true, y: saved?.y === true }
  } catch {
    return { x: false, y: false }
  }
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
const noticeAsk = $('noticeAsk')
const adjustChannels = $('adjustChannels')
const realityLead = $('realityLead')
const realityCharts = $('realityCharts')
const stepBar = $('stepBar')
const stepsBar = $('stepsBar')
const stepBlob = $('stepBlob')
const nextBtn = $('nextBtn')
const coloursBtn = $('coloursBtn')
const submitBtn = $('submitBtn')
const noBtn = $('noBtn')
const yesBtn = $('yesBtn')
const originalBtn = $('originalBtn')
const resetBtn = $('resetBtn')
const slidersTitle = $('slidersTitle')
const filterWheel = $('filterWheel')
const verdictBlock = $('verdict')
const editVerdictBlock = $('editVerdict')
const scaleTpl = $('scaleTpl')
const confirmAsk = $('confirmAsk')
const confirmPic = $('confirmPic')
const confirmCanvas = $('confirmCanvas')
const originalPic = $('originalPic')
const originalCanvas = $('originalCanvas')
const originalCol = $('originalCol')
const editedCol = $('editedCol')
const liveCrop = $('liveCrop')
const standIn = $('standIn')
const reelTop = $('reelTop')
const DOCK = [shutter, nextBtn, coloursBtn, submitBtn, noBtn, yesBtn, originalBtn, resetBtn]
// The three answers to the share question, in the order they sit in the dock.
const SHARE_BTNS = [noBtn, yesBtn, originalBtn]

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
  { id: 'adjust', action: ['coloursBtn', 'submitBtn'], mark: 1 },
  { id: 'confirm', action: ['noBtn', 'yesBtn', 'originalBtn'], mark: 2 },
  { id: 'reality', action: ['resetBtn'], mark: 3 },
]
const STEP_IDS = STEPS.map((s) => s.id)


let gen = 0
let anims = []
let timers = []

let frame = null // { width, height, planes, histograms, rest } — written once, read-only after
let viewFrame = null // the same photo, small enough to redraw on every pointermove
let thumbFrame = null // ...and smaller still, for the three channel layers on step 2
let levels = null // [{black, white} x3] — the only thing the visitor changes

// The colour each channel's light is being shown in, in degrees around the spectrum. Starts on
// each channel's own hue, which is where a camera leaves it; step 3 lets the visitor move them
// anywhere, independently — two channels can share a colour, and the picture is their sum.
let shownHue = CHANNELS.map((c) => c.hue)
let recoloured = false

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

  // Leaving the screen that asked is the moment its answers are final, however it is left —
  // pressing on, or the exhibit giving up and starting again with nobody there.
  if (step() !== id && step() === 'confirm') sendVerdicts()

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
  // A new step is a fresh minute, and the camera step has none.
  idleArm()
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
  // The wheel is placed from the photograph's measured box, so a window that changes shape
  // has to have it placed again.
  if (wheelLive) {
    placeWheel()
    clearStarsOffPicture()
    layoutNotes()
  }
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
// ── what to ask the camera for, and what to do about a noisy one ───────────
//
// Both live in the debug menu and both are remembered, because both are answers to a question
// about one particular camera bolted to one particular wall, and the machine gets turned off
// at night.

// What to ask the camera for. `split` is the default: the viewfinder at 1080p, and 4K only for
// the photograph (see "a small live picture, a big photograph" below). `ladder` is 4K all the
// time, climbing down if it refuses or opens without sending a picture. The rest pin one size,
// for a camera that negotiates 4K slowly enough to be worth skipping, or has been seen to lie.
const RES_MODES = ['split', 'ladder', '4k', '1440', '1080', '720']
const RES_KEY = 'sharedsky.res'
let resAt = (() => {
  try {
    const found = RES_MODES.indexOf(localStorage.getItem(RES_KEY))
    return found < 0 ? 0 : found
  } catch {
    return 0
  }
})()

// ── a small live picture, a big photograph ──────────────────────────────────
//
// At 4K the exhibit machine spends about a whole core decoding the camera, all day, whether
// anybody is standing there or not — and a browser with no time to spare is what tears frames.
// The viewfinder does not need 4K: it is shown at about 2000 pixels across and nobody can tell
// the difference while it moves. Only the photograph does. So in `split` the camera runs at
// 1080p, which is about half the decoding (1080p at 60 frames a second against 4K at 30), and
// is switched up to 4K when the countdown starts — which gives the switch the whole countdown
// to happen in — then back down once the picture is taken.
//
// The switch retunes the running track first, which is quick and never lets go of the camera.
// If the browser will not do that, it reopens at 4K, and if 4K will not come the photograph is
// taken at whatever is running: a visitor must never lose the picture to a resolution.

/** What to show, and what to take the photograph at — null when that is the same thing. */
function camPlan() {
  const key = RES_MODES[resAt]
  // A `?res=` on the kiosk shortcut still wins over the default, as it always has.
  const url = new URLSearchParams(location.search).get('res')
  if (key === 'split') return url ? { preview: url, photo: null } : { preview: '1080', photo: '4k' }
  return { preview: key, photo: null }
}

/** What openCamera should ask for: the debug setting, or the URL when it has not been set. */
function wantedRes() {
  return camPlan().preview
}

async function setRes(next) {
  resAt = ((next % RES_MODES.length) + RES_MODES.length) % RES_MODES.length
  try {
    localStorage.setItem(RES_KEY, RES_MODES[resAt])
  } catch {
    // Not being able to remember it is no reason to refuse to do it.
  }
  await queueCamera(openCamera)
}

// Every change to the camera goes through here, one at a time. Two requests in flight on one
// USB camera is how a slow camera becomes a dead one — see camera.js.
let camQueue = Promise.resolve()
// How many camera jobs are queued or running. The viewfinder watchdog stands back while any are:
// a camera in the middle of being switched is allowed a moment with no pictures.
let camJobs = 0
function queueCamera(job) {
  camJobs++
  const run = camQueue.then(job, job)
  camQueue = run.catch(() => {}).finally(() => camJobs--)
  return run
}

// The switch up for the photograph in hand, started with the countdown.
let photoSize = null

const after = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * How tall the camera's frames are now. The track's own word while the viewfinder is paused —
 * it is, straight after every photograph, and a paused element never learns the new size.
 */
function heightNow(track) {
  return feed.paused ? track?.getSettings?.().height : feed.videoHeight
}

/** Resolves true once the camera is sending frames `height` tall, false at the deadline. */
function framesAt(track, height, ms) {
  return new Promise((done) => {
    const deadline = performance.now() + ms
    const look = () => {
      if (heightNow(track) === height) return done(true)
      if (performance.now() > deadline) return done(false)
      setTimeout(look, 50)
    }
    look()
  })
}

/**
 * Put the camera at this size. True if it got there; false if the picture is running at some
 * other size, which is still a picture.
 */
async function resizeCamera(res) {
  const want = sizeFor(res)
  const height = want.height?.ideal
  const track = feed.srcObject?.getVideoTracks?.()[0]
  if (!height || !track || track.readyState !== 'live') return false
  if (heightNow(track) === height) return true

  const started = performance.now()
  const took = () => `${Math.round(performance.now() - started)}ms`
  try {
    await Promise.race([track.applyConstraints(want), after(4000).then(() => Promise.reject(new Error('timeout')))])
    if (await framesAt(track, height, 3000)) {
      setInfo('camera switch', `${res}: retuned in ${took()}`)
      return true
    }
  } catch (err) {
    setInfo('camera switch', `${res}: retune ${err.name === 'Error' ? err.message : err.name} - reopening`)
  }

  // The browser would not change the running stream, or said it had and did not. Let go of it
  // and open at the new size; startCamera climbs down on its own if this size will not come.
  try {
    camHandle?.stop()
    camHandle = null
    const q = new URLSearchParams(location.search)
    camHandle = await startCamera(feed, { want: q.get('cam'), res, fps: q.get('fps') })
    const got = camHandle.stream.getVideoTracks()[0]
    setInfo('camera switch', `${res}: reopened in ${took()} at ${got?.getSettings?.().width}x${heightNow(got)}`)
    return heightNow(got) === height
  } catch (err) {
    setInfo('camera switch', `${res}: ${err.name} - back to the viewfinder size`)
    await openCamera()
    return false
  }
}

/** Start the switch up to the photograph's size, if this plan has one. Safe to call twice. */
function primePhotoSize() {
  const { photo } = camPlan()
  if (!photo || standingIn) return null
  photoSize ??= queueCamera(() => resizeCamera(photo))
  return photoSize
}

/** Back to the viewfinder's size, after a photograph or a countdown nobody finished. */
function restorePreviewSize() {
  photoSize = null
  const { photo, preview } = camPlan()
  if (!photo || standingIn) return
  queueCamera(() => resizeCamera(preview))
}

// How to deal with the noise a sensor produces. Nothing in this pipeline creates any — the
// capture resamples with a real filter, every smaller copy is a box average, and both of those
// reduce it. The one thing that makes it worse is the levels opening on the 0.5th and 99.5th
// percentile, which multiplies everything inside that range, noise included, by
// 255 / (white - black); `levels gain` in the overlay is that number for the last capture.
//
// So these are about the sensor. Stacking is the astrophotographer's answer and the better one
// where it can be used; the sigma filter is for a subject that will not hold still.
// `clean` is in multiples of the frame's own measured noise, not in levels — see denoiseFrame.
const DENOISE = [
  { key: 'off', label: 'off', shots: 1, clean: 0 },
  { key: 'stack4', label: 'stack 4', shots: 4, clean: 0 },
  { key: 'stack8', label: 'stack 8', shots: 8, clean: 0 },
  { key: 'smooth', label: 'smooth', shots: 1, clean: 2.5 },
  { key: 'both', label: 'stack 4 + smooth', shots: 4, clean: 2.5 },
]
const DENOISE_KEY = 'sharedsky.denoise'
let denoiseAt = (() => {
  try {
    const found = DENOISE.findIndex((d) => d.key === localStorage.getItem(DENOISE_KEY))
    return found < 0 ? 0 : found
  } catch {
    return 0
  }
})()

function setDenoise(next) {
  denoiseAt = ((next % DENOISE.length) + DENOISE.length) % DENOISE.length
  try {
    localStorage.setItem(DENOISE_KEY, DENOISE[denoiseAt].key)
  } catch {
    // As above.
  }
  setInfo('denoise', DENOISE[denoiseAt].label)
}

/**
 * Wait for the camera to deliver a frame that is not the one just taken.
 *
 * Stacking the same frame eight times is eight times the work and none of the benefit: the
 * noise has to be different in each one or there is nothing for the average to cancel.
 */
function nextCameraFrame() {
  return new Promise((resolve) => {
    if (!feed.requestVideoFrameCallback) return void setTimeout(resolve, 40)
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    feed.requestVideoFrameCallback(finish)
    // A camera that has stopped sending must not hang the shutter.
    setTimeout(finish, 150)
  })
}

// ── torn frames ─────────────────────────────────────────────────────────────
//
// At 4K in Firefox the bottom of the viewfinder now and then flashes with a frame that arrived
// half garbage. See js/frameguard.js for how one is told from a real change. `both` keeps them
// off the screen and out of the photograph; `capture` only out of the photograph, for a machine
// that cannot spare the few milliseconds a frame the viewfinder costs; `off` is as it was.
const GUARD_MODES = [
  { key: 'both', label: 'viewfinder + photo' },
  { key: 'capture', label: 'photo only' },
  { key: 'off', label: 'off' },
]
const GUARD_KEY = 'sharedsky.guard'
let guardAt = (() => {
  try {
    const found = GUARD_MODES.findIndex((g) => g.key === localStorage.getItem(GUARD_KEY))
    return found < 0 ? 0 : found
  } catch {
    return 0
  }
})()

// ── the noise in the dark, cleaned as it arrives ──────────────────────────
//
// See js/livedenoise.js. It rides on the frame guard's viewfinder, which already draws every
// frame itself, so with the guard off or on the photo only there is no live clean-up — the
// photograph still gets its share. `colour` by default: it has nothing to trade against motion.
const LIVE_KEY = 'sharedsky.livedenoise'
const live = createLiveDenoise()
live.mode = (() => {
  try {
    const saved = localStorage.getItem(LIVE_KEY)
    return LIVE_MODES.includes(saved) ? saved : 'colour'
  } catch {
    return 'colour'
  }
})()

function setLive(next) {
  live.mode = LIVE_MODES[((next % LIVE_MODES.length) + LIVE_MODES.length) % LIVE_MODES.length]
  try {
    localStorage.setItem(LIVE_KEY, live.mode)
  } catch {
    // Not being able to remember it is no reason to refuse to do it.
  }
}

const guard = createFrameGuard(feed, {
  host: liveCrop,
  process: (video, w, h) => live.frame(video, w, h),
  // The crop enlarges the wrapper, so the viewfinder shows fewer camera pixels over the same
  // screen — the canvases are drawn big enough for that, or a crop would soften the picture.
  zoom: () => cropWindow().zoom,
  onReport: (s) =>
    setInfo(
      'frame guard',
      s.mode === 'off'
        ? 'off'
        : `${GUARD_MODES.find((g) => g.key === s.mode).label} · caught ${s.preview} on screen, ${s.capture} in photos` +
            (s.mode === 'both' ? ` · ${s.cost.toFixed(1)}ms a frame` : '') +
            (s.last ? `\nlast: ${s.last}` : '')
    ),
})

function setGuard(next) {
  guardAt = ((next % GUARD_MODES.length) + GUARD_MODES.length) % GUARD_MODES.length
  try {
    localStorage.setItem(GUARD_KEY, GUARD_MODES[guardAt].key)
  } catch {
    // As above.
  }
  guard.setMode(GUARD_MODES[guardAt].key)
}

/** One capture, or several averaged into one, depending on what the menu says. */
async function captureWithDenoise() {
  const mode = DENOISE[denoiseAt]
  const shots = []
  // Every one of them checked, so a stack of eight cannot average a torn frame into the photo.
  // A frame headed for a stack skips its histograms; the stack counts its own from the result.
  const stats = mode.shots === 1
  await guard.eachClean(mode.shots, nextCameraFrame, (source) => {
    const shot = captureFrame(source, CAPTURE_EDGE, camRot, cropWindow(), {
      stats,
      flip: flipAt,
      clean: (canvas, w, h) => live.still(canvas, w, h),
    })
    if (shot) shots.push(shot)
  })
  if (!shots.length) return null

  const started = performance.now()
  let out = shots.length > 1 ? stackFrames(shots) : ensureStats(shots[0])
  if (mode.clean) out = denoiseFrame(out, mode.clean)
  if (mode.shots > 1 || mode.clean) {
    setInfo('denoise', `${mode.label} - ${shots.length} shot(s), ${Math.round(performance.now() - started)}ms`)
  }
  return out
}

// Shared by the two controls below that work an edge at a time. Declared here rather than with
// either of them: whichever came second would be reading it before it existed.
const EDGES = ['top', 'right', 'bottom', 'left']

// ── fitting the piece to the thing it is built into ───────────────────────
//
// A kiosk goes inside a housing, and the housing's aperture is never quite the panel. These
// four take room off the edges of the whole page — the bar, the screen and the dock together —
// so the piece can be walked into position on the day without touching a stylesheet. In vw and
// vh rather than pixels, so a panel swapped for a different one keeps the same fit.
const PAD_KEY = 'sharedsky.pad'
const PAD_MAX = 12

let padAt = (() => {
  const none = { top: 0, right: 0, bottom: 0, left: 0 }
  try {
    const saved = JSON.parse(localStorage.getItem(PAD_KEY) ?? 'null')
    if (!saved) return none
    for (const edge of EDGES) {
      const n = Number(saved[edge])
      none[edge] = Number.isFinite(n) ? Math.min(PAD_MAX, Math.max(0, n)) : 0
    }
    return none
  } catch {
    // Storage disabled, or somebody put something else under that key.
    return none
  }
})()

function applyPad() {
  const root = document.documentElement.style
  // Horizontal against the width and vertical against the height: an edge of a landscape panel
  // and an edge of a portrait one are not the same distance, and a single unit for both makes
  // one pair of these useless on whichever way round the screen is.
  root.setProperty('--pad-l', `${padAt.left}vw`)
  root.setProperty('--pad-r', `${padAt.right}vw`)
  root.setProperty('--pad-t', `${padAt.top}vh`)
  root.setProperty('--pad-b', `${padAt.bottom}vh`)
  setInfo(
    'padding',
    EDGES.some((edge) => padAt[edge])
      ? EDGES.map((edge) => `${edge[0]}${padAt[edge]}`).join(' ')
      : null
  )
}

function setPad(edge, value) {
  padAt[edge] = Math.min(PAD_MAX, Math.max(0, Number(value) || 0))
  try {
    localStorage.setItem(PAD_KEY, JSON.stringify(padAt))
  } catch {
    // Not being able to remember it is no reason to refuse to do it.
  }
  applyPad()
}

function clearPad() {
  for (const edge of EDGES) padAt[edge] = 0
  try {
    localStorage.setItem(PAD_KEY, JSON.stringify(padAt))
  } catch {}
  applyPad()
}

const CROP_KEY = 'sharedsky.crop'
const CROP_MAX = 40 // per edge, %. Past this there is not enough left to stand in.

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

/**
 * The kept window, in the terms both the viewfinder and the capture need.
 *
 * The four edges are the edges of the screen. A flip turns the picture over after the window is
 * taken, so under a flip the window is taken from the opposite edge — or "Crop top" would trim
 * whatever had been flipped to the bottom.
 */
function cropWindow() {
  const l = (flipAt.x ? cropAt.right : cropAt.left) / 100
  const r = (flipAt.x ? cropAt.left : cropAt.right) / 100
  const t0 = (flipAt.y ? cropAt.bottom : cropAt.top) / 100
  const b = (flipAt.y ? cropAt.top : cropAt.bottom) / 100
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
  // The flips go leftmost, so they turn over the finished window, as the capture does.
  liveCrop.style.transform =
    `scale(${flipAt.x ? -1 : 1}, ${flipAt.y ? -1 : 1}) ` +
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

/** Flip the picture on one axis, and remember it — the bracket will be the same tomorrow. */
function toggleFlip(axis) {
  flipAt[axis] = !flipAt[axis]
  try {
    localStorage.setItem(FLIP_KEY, JSON.stringify(flipAt))
  } catch {
    // Not being able to remember it is no reason to refuse to do it.
  }
  applyCrop()
  setInfo('flip', flipAt.x || flipAt.y ? `${flipAt.x ? 'x ' : ''}${flipAt.y ? 'y' : ''}`.trim() : null)
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

// How the last request to leave or re-enter kiosk mode went, shown on its row in the menu —
// cut short there, because the row does not wrap; the whole of it goes to the overlay.
const kioskNote = {}
const shortNote = (note = '') => (note.length > 22 ? `${note.slice(0, 21)}…` : note)

/**
 * Ask the server to take the browser out of kiosk mode, or put it back.
 *
 * A page cannot do either to the browser it is in; see server/kiosk.js. When it works the answer
 * hardly matters, because this page is about to be closed. When it does not — the dev machine, or
 * a kiosk set up some other way — the reason goes on the button, for the person who pressed it.
 */
async function askKiosk(action) {
  kioskNote[action] = '…'
  refreshDebug()
  try {
    const res = await fetch('api/kiosk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    const body = await res.json().catch(() => ({}))
    kioskNote[action] = res.ok ? 'on its way' : `refused: ${body.error ?? res.status}`
  } catch (err) {
    kioskNote[action] = `failed: ${err?.message ?? err}`
  }
  setInfo('kiosk', `${action} ${kioskNote[action]}`)
  refreshDebug()
}

// ── the camera's exposure, through the server ──────────────────────────────
//
// See server/camera.js: Firefox gives a page no say over exposure, so the server sets it with
// v4l2-ctl, the way qv4l2 does. What the camera last said, for the menu to show; null until it
// has answered, with the reason in `exposureNote` if it will not.
let exposure = null
let exposureNote = '…'

async function exposureAsk(body) {
  try {
    const res = await fetch('api/camera/exposure', body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { cache: 'no-store' })
    const answer = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(answer.error ?? res.status)
    exposure = answer
    exposureNote = ''
    setInfo('exposure', `${answer.mode}, ${exposureMs(answer.time.value)} on ${answer.device}`)
  } catch (err) {
    exposure = null
    exposureNote = res501(err) ? 'not here' : 'unavailable'
    setInfo('exposure', `unavailable: ${err?.message ?? err}`)
  }
}
const res501 = (err) => /only on the exhibit machine/.test(String(err?.message ?? err))

/** The camera's units are tenths of a millisecond. */
const exposureMs = (units) => {
  const ms = units / 10
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`
}

// The slider runs 0-100 and is mapped onto the camera's range logarithmically: its range is
// typically a tenth of a millisecond to half a second, and everything that matters for a moving
// subject at 30 frames a second is under 33ms — on a straight scale, the first few percent.
const EXPOSURE_STEPS = 100
function exposureFromSlider(p) {
  const { min, max } = exposure.time
  const lo = Math.log(Math.max(1, min))
  return Math.round(Math.exp(lo + ((Math.log(max) - lo) * p) / EXPOSURE_STEPS))
}
function exposureToSlider(units) {
  const { min, max } = exposure.time
  const lo = Math.log(Math.max(1, min))
  return Math.round(((Math.log(Math.max(1, units)) - lo) / (Math.log(max) - lo)) * EXPOSURE_STEPS)
}

// One change in flight at a time, and always ending on the latest: a drag fires far faster than
// v4l2-ctl answers, and queueing every step of it would leave the camera catching up for seconds.
let exposureSending = false
let exposureWanted = null
async function sendExposureTime(units) {
  exposureWanted = units
  if (exposureSending) return
  exposureSending = true
  while (exposureWanted !== null) {
    const next = exposureWanted
    exposureWanted = null
    await exposureAsk({ time: next })
  }
  exposureSending = false
}

/**
 * What the debug menu can do.
 *
 * Registered here rather than declared in perf.js, because these are this screen's own switches
 * and the overlay has no business knowing what a camera rotation is. Actions only, no readouts:
 * facts belong in the HUD, which is already showing them.
 */
function registerDebugActions() {
  exposureAsk()
  addDebugAction({
    label: 'Rotate camera',
    hint: 'quarter turn — viewfinder and capture together, remembered on this machine',
    state: () => `${camRot}°`,
    run: () => setRotation(camRot + 90),
  })
  addDebugAction({
    label: 'Mirror X',
    hint: 'flips left to right as seen on screen — viewfinder and photo together, remembered on this machine',
    state: () => (flipAt.x ? 'flipped' : 'as is'),
    run: () => toggleFlip('x'),
  })
  addDebugAction({
    label: 'Mirror Y',
    hint: 'flips top to bottom as seen on screen — viewfinder and photo together, remembered on this machine',
    state: () => (flipAt.y ? 'flipped' : 'as is'),
    run: () => toggleFlip('y'),
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
  for (const edge of EDGES) {
    addDebugSlider({
      label: `Pad ${edge}`,
      hint: edge === 'top'
        ? 'takes room off the edge of the whole page — the bar, the screen and the button together — to fit the piece inside its housing'
        : undefined,
      min: 0,
      max: PAD_MAX,
      step: 0.25,
      get: () => padAt[edge],
      set: (value) => setPad(edge, value),
      format: (value) => `${value}${edge === 'top' || edge === 'bottom' ? 'vh' : 'vw'}`,
    })
  }
  addDebugAction({
    label: 'Clear the padding',
    hint: 'all four edges back to nothing',
    state: () => (EDGES.some((edge) => padAt[edge]) ? 'fitted' : 'flush'),
    run: () => clearPad(),
  })
  addDebugAction({
    label: 'Clear the crop',
    hint: 'all four edges back to nothing',
    state: () => (EDGES.some((edge) => cropAt[edge]) ? 'cropped' : 'clear'),
    run: () => clearCrop(),
  })
  addDebugAction({
    label: 'Camera resolution',
    hint: 'split shows 1080p and takes the photo at 4K; ladder is 4K throughout, climbing down if it will not send a picture',
    state: () => RES_MODES[resAt],
    run: () => setRes(resAt + 1),
  })
  addDebugAction({
    label: 'Frame guard',
    hint: 'drops frames that arrive torn — the flashing at the bottom of the picture at 4K; the overlay counts what it catches',
    state: () => GUARD_MODES[guardAt].label,
    run: () => setGuard(guardAt + 1),
  })
  addDebugAction({
    label: 'Exposure',
    hint: 'the camera’s own exposure, as qv4l2 sets it — auto, or manual with the time below; done by the server on the exhibit machine, and forgotten if the camera is unplugged',
    state: () => exposure?.mode ?? exposureNote,
    run: async () => {
      // Not heard from the camera yet: ask again, rather than switch blind.
      if (exposure) await exposureAsk({ mode: exposure.mode === 'manual' ? 'auto' : 'manual' })
      else await exposureAsk()
      refreshDebug()
    },
  })
  addDebugSlider({
    label: 'Exposure time',
    hint: 'longer is brighter and less noisy, but past 33 ms the camera cannot keep 30 frames a second and moving things blur',
    min: 0,
    max: EXPOSURE_STEPS,
    step: 1,
    shown: () => exposure?.mode === 'manual',
    get: () => exposureToSlider(exposure.time.value),
    set: (p) => {
      const units = exposureFromSlider(p)
      // Kept here as well, so a redraw of the menu mid-drag puts the slider where the finger is.
      exposure.time.value = units
      sendExposureTime(units)
    },
    format: (p) => exposureMs(exposureFromSlider(p)),
  })
  addDebugAction({
    label: 'Live denoise',
    hint: 'cleans the noise in the dark parts of the viewfinder and the photo; colour + time also averages frames, which can leave faint trails behind fast movement — the viewfinder half needs the frame guard on viewfinder + photo',
    state: () =>
      !live.available
        ? 'no WebGL'
        : live.mode === 'off'
          ? 'off'
          : `${live.mode}${GUARD_MODES[guardAt].key === 'both' ? '' : ' (photo only)'}`,
    run: () => setLive(LIVE_MODES.indexOf(live.mode) + 1),
  })
  addDebugAction({
    label: 'Denoise',
    hint: 'stacking averages several frames, which is what an astrophotographer does; smooth is one frame, flat areas only',
    state: () => DENOISE[denoiseAt].label,
    run: () => setDenoise(denoiseAt + 1),
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
  addDebugAction({
    label: 'Exit kiosk mode',
    hint: 'closes the full-screen kiosk and opens this page in an ordinary browser window, with tabs and developer tools — done by the server, on the exhibit machine only',
    state: () => shortNote(kioskNote.exit),
    run: () => askKiosk('exit'),
  })
  addDebugAction({
    label: 'Back to kiosk mode',
    hint: 'from that ordinary window: closes it and starts the kiosk again',
    state: () => shortNote(kioskNote.enter),
    run: () => askKiosk('enter'),
  })
  addDebugAction({
    label: 'Reload page',
    hint: 'a real browser refresh, for kiosk mode where there is no F5 — picks up a new version after an update',
    run: () => location.reload(),
  })
}

// ── the photo bay: two stacked canvases, so any change can crossfade ────────

const lutsNow = () => levels.map((l) => levelsLut(l.black, l.white))

// Steps 2 and 4 are the same three controls over two different pictures. Everything that acts
// on "the thing being edited" asks these rather than reaching for `frame` and `levels`, which
// is what lets one draw path and one settling animation serve both.
/** What the drawing path wants: each channel's colour as weights on the three outputs. */
const tints = () => shownHue.map(hueTint)

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
  if (!frame || !levels) return

  count('draws')
  measure('levels', () => {
    bigEditors.forEach((e, i) => (only === -1 || only === i) && e.redraw())
    if (step() === 'adjust') drawAdjust()
    else drawUpTo(lit)
  })
}

/** A handle moved: mark it and let the next frame draw it. */
function onLevelsChanged(index) {
  queueDraw(index)
  if (step() === 'adjust') askWhatTheyNotice()
}

// Asked once the visitor has changed something on the colours screen — a colour or a handle,
// either counts — so it is asked of what they have just done.
const NOTICE_ASK = 'What do you notice?'

function askWhatTheyNotice() {
  if (noticeAsk.childNodes.length) return
  noticeAsk.textContent = NOTICE_ASK
  rise(noticeAsk)
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
      // What the camera is set to now: somebody may have changed it from a terminal since.
      exposureAsk().then(refreshDebug)
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
  applyRotation()
  applyPad()
  applyCrop()
  guard.setMode(GUARD_MODES[guardAt].key)
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
    // Show the camera first, whatever was asked for. Every jump starts here — the later steps
    // need a photograph and this one *is* the camera — and without it `?step=camera` returned
    // below without ever opening a step, which is a blank screen with a working camera behind
    // it. The other jumps only gain the viewfinder they were always standing in front of.
    goToStep('camera', { animate: false })
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
// ── no camera, but still an exhibit ────────────────────────────────────────
//
// A camera that will not open used to end the piece: the message went up and the shutter stayed
// dead, so nobody could see what the exhibit was for. It now borrows a picture from the gallery
// and runs on that, with the fault still on screen — the visitor gets the whole piece, and
// whoever looks after it still gets told.
let standingIn = false

/**
 * Put a picture from the wall in the viewfinder.
 *
 * `fresh` picks another one; without it a run of failed retries would swap the picture every
 * fifteen seconds under somebody who is standing there reading.
 */
async function useStandIn({ fresh = false } = {}) {
  if (standingIn && !fresh) {
    // showCameraFault disables the shutter every time it runs, and it runs on every retry.
    shutter.disabled = false
    return true
  }

  const pool = await loadReelPool()
  if (!pool.length) return false // nothing curated to borrow; the message stands on its own

  const pick = pool[Math.floor(Math.random() * pool.length)]
  const loaded = await new Promise((done) => {
    standIn.onload = () => done(true)
    standIn.onerror = () => done(false)
    standIn.src = pick.src
  })
  if (!loaded || !standIn.naturalWidth) return false

  standingIn = true
  standIn.hidden = false
  // Set straight rather than through setAspect, which exists to undo the bracket's rotation.
  // This picture has the shape it has.
  document.documentElement.style.setProperty(
    '--shot-ar',
    (standIn.naturalWidth / standIn.naturalHeight).toFixed(4)
  )
  shutter.disabled = false
  const example = $('camErrExample')
  if (example) example.hidden = false
  setInfo('stand-in', `${pick.file} (no camera)`)
  return true
}

/** The camera turned up after all. */
function dropStandIn() {
  if (!standingIn) return
  standingIn = false
  standIn.hidden = true
  standIn.removeAttribute('src')
  setInfo('stand-in', null)
}

// What the running camera is held by. Without this a second open leaves the first one running:
// assigning a new srcObject does not stop the old tracks, it only stops showing them.
let camHandle = null

async function openCamera() {
  try {
    camHandle?.stop()
    camHandle = null
    const q = new URLSearchParams(location.search)
    camHandle = await startCamera(feed, { want: q.get('cam'), res: wantedRes(), fps: q.get('fps') })
    dropStandIn()
    setAspect(feed.videoWidth, feed.videoHeight)
    $('camError').hidden = true
    shutter.disabled = false
    setInfo('camera error', null)
    if (camAttempt) setInfo('camera', `recovered on attempt ${camAttempt + 1}`)
    camAttempt = 0
  } catch (err) {
    camAttempt++
    showCameraFault(err)
    // Deliberately not awaited before the retry is queued: borrowing a picture involves the
    // network, and the retry should not wait on it.
    useStandIn()
    setTimeout(openCamera, TIMELINE.cameraRetryAt)
  }
}

// ── a viewfinder that has stopped ──────────────────────────────────────────
//
// Every visitor's turn switches the camera twice — up to 4K for the photograph, and back — and
// pauses the viewfinder at the shutter. Any of that can leave it standing still: a USB camera
// that changes mode and then sends nothing while still reporting itself live, or a play() that
// was refused and left the video paused. Neither raises an error, so nothing else notices, and
// the next visitor walks up to a frozen picture or none.
//
// So on the camera screen, and only there, the viewfinder is watched for new frames. Two
// seconds with none, and it is told to play again. Five, and the camera is let go and opened
// afresh — after a pause, because on Linux a camera reopened the instant it is released is
// still busy. Never during the countdown and the photograph, never while a camera job is under
// way, and never while a borrowed picture is standing in: those have their own handling.
const WATCH = { replayAfter: 2000, reopenAfter: 5000, release: 800, quietAfterReopen: 10000 }

// Whether a countdown or photograph is in progress, when a pause in the frames is expected.
let shooting = false
let viewfinderFrameAt = 0 // when the viewfinder last showed a new frame, on the performance clock
let frameWatchArmed = false
let lastFrameTotal = -1
let replayed = false
let watchQuietUntil = 0
const dog = { replays: 0, reopens: 0 }

/** Note every frame the viewfinder presents. Re-armed by the watchdog if a new stream drops it. */
function armFrameWatch() {
  if (frameWatchArmed || !feed.requestVideoFrameCallback) return
  frameWatchArmed = true
  feed.requestVideoFrameCallback(() => {
    frameWatchArmed = false
    viewfinderFrameAt = performance.now()
    armFrameWatch()
  })
}

function noteWatchdog(what) {
  const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  setInfo('watchdog', `replayed ${dog.replays} · reopened ${dog.reopens} · last: ${what} at ${at}`)
}

setInterval(() => {
  const now = performance.now()
  armFrameWatch()
  // Riding on this clock rather than one of its own: the live denoise's cost, for the overlay.
  setInfo('live denoise', live.available ? `${live.mode}${live.mode === 'off' ? '' : ` · ${live.cost.toFixed(1)}ms a frame`}` : 'no WebGL')
  // A second witness, for a browser whose frame callback stalls when nothing else does.
  const total = feed.getVideoPlaybackQuality?.().totalVideoFrames
  if (total != null && total !== lastFrameTotal) {
    lastFrameTotal = total
    viewfinderFrameAt = now
  }

  const watching =
    step() === 'camera' &&
    !shooting &&
    !standingIn &&
    camJobs === 0 &&
    camHandle &&
    $('camError').hidden &&
    document.visibilityState === 'visible' &&
    now >= watchQuietUntil
  if (!watching) {
    // The clock only runs while it is watching, so arriving back on this screen after minutes
    // elsewhere is two seconds' grace, not an instant alarm.
    viewfinderFrameAt = now
    replayed = false
    return
  }

  const still = now - viewfinderFrameAt
  if (still < WATCH.replayAfter) {
    replayed = false
    return
  }
  if (!replayed) {
    replayed = true
    dog.replays++
    noteWatchdog(`${feed.paused ? 'paused' : 'no frames'} ${(still / 1000).toFixed(1)}s, played again`)
    feed.play().catch((err) => setInfo('play', `${err.name} - watchdog replay refused`))
    return
  }
  if (still < WATCH.reopenAfter) return

  dog.reopens++
  replayed = false
  watchQuietUntil = now + WATCH.quietAfterReopen
  noteWatchdog(`no frames ${(still / 1000).toFixed(1)}s, reopened the camera`)
  queueCamera(async () => {
    camHandle?.stop()
    camHandle = null
    feed.srcObject = null
    await after(WATCH.release)
    await openCamera()
  })
}, 500)

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
    // Opened, handed over a live track, and sent nothing — which on a 4K HDR camera usually
    // means a format the browser cannot convert. The ladder has already tried asking for less
    // by the time this is shown, so the next thing to try is pinning it on the shortcut.
    NoFramesError:
      'The camera opened but sent no picture. Add ?res=1080 to the address to stop asking it for 4K.',
  }
  // What a visitor reads: an invitation to use the example, and nothing about the fault. It
  // waits for the stand-in to actually load, because offering an example photograph that is not
  // on screen is worse than saying nothing.
  const said = document.createElement('span')
  said.className = 'err-public'
  const example = document.createElement('span')
  example.id = 'camErrExample'
  example.textContent = 'Try sharing your sky with this example astrophotograph!'
  example.hidden = !standingIn
  said.append(example)

  // Everything below is for whoever is fixing it, and shows only while the debug menu is open.
  // Each cause has a completely different fix, so the cause is spelled out — and on the
  // screen, not only in the overlay, because the person fixing a kiosk is usually holding
  // nothing but a phone to photograph it with.
  const service = document.createElement('span')
  service.className = 'err-debug'
  service.append(
    err instanceof CameraSetupError ? err.message : (SAID[err.name] ?? `No camera: ${err.message}`)
  )
  box.replaceChildren(said, service)

  const borrowed = document.createElement('small')
  borrowed.className = 'err-standin'
  borrowed.textContent = 'Showing a picture from the gallery instead, so you can still try it.'
  service.append(borrowed)

  const detail = document.createElement('small')
  detail.className = 'err-detail'
  detail.textContent =
    `retrying every ${Math.round(TIMELINE.cameraRetryAt / 1000)}s · attempt ${camAttempt} · ` +
    `${err.name}` +
    ` · ${location.protocol}//${location.host}` +
    ` · secure ${window.isSecureContext}` +
    ` · ${navigator.userAgent.includes('Firefox') ? 'firefox' : 'chromium'}`
  service.append(detail)

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
 * what lets `?step=reality` work: the step builds whatever it needs and does not care how the
 * visitor got there. Three of the four are sequences rather than screens, and each is written
 * as one async function so that the code reads in the order the visitor sees it.
 */
const STEP_ENTER = {
  camera() {
    shutter.disabled = !feed.videoWidth
    // The shutter paused it. Asked here as well as in reset(), so a play() refused there is
    // asked again the moment the screen is back; the watchdog keeps asking after that.
    if (feed.srcObject && feed.paused) feed.play().catch(() => {})
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

    // Both paragraphs in place before anything moves, invisible, so the screen is laid out at
    // its finished size. The group is centred, and text arriving into empty paragraphs would
    // grow it and shove the photograph up the screen just after it has landed.
    for (const [el, segments] of [[storyEl, STORY], [storyAfterEl, STORY_AFTER]]) {
      writeSegments(el, segments)
      el.style.opacity = '0'
    }

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
    coloursBtn.classList.add('waiting')
    coloursBtn.disabled = false
    drawAdjust()
    // The paragraph in place before the picture moves, invisible, so the centred group already
    // has its finished height and the picture does not jump when the text fades in.
    writeSegments(adjustStoryEl, ADJUST_STORY)
    adjustStoryEl.style.opacity = '0'

    await flyInto(adjustPic, TIMELINE.photoFlight)
    // The wheel starts turning while the sentences are being read, not after them.
    startWheel()
    await wait(t(TIMELINE.storyLeadIn))
    await fadeIn(adjustStoryEl, ADJUST_STORY)
    if (step() !== 'adjust') return

    // The colours are offered when the visitor asks for them, not on a timer. A pause long
    // enough to read two sentences is a pause long enough to look like the exhibit has stopped,
    // and handing over the controls before they have read it answers the question for them.
    coloursBtn.classList.remove('waiting')
    coloursPop = pop(coloursBtn)
  },

  // The picture they made beside the one the camera made, "Is this image real?" asked of each,
  // and then the one question in the piece with a wrong answer.
  async confirm() {
    if (!frame) return
    confirmAsk.replaceChildren()
    editVerdict.clear()
    adjustVerdict.clear()
    for (const el of [confirmPic, originalPic, originalCol, editedCol]) el.style.visibility = ''
    // The answers wait for both questions. They are in the dock at the foot of the screen, and
    // arriving early would offer a choice before the pictures have been looked at.
    for (const btn of SHARE_BTNS) {
      btn.disabled = false
      btn.classList.add('waiting')
    }
    drawComposite(confirmCanvas, viewFrame ?? frame, lutsNow(), tints())
    drawComposite(originalCanvas, viewFrame ?? frame, originalLuts(), ORIGINAL_TINTS)
    // Hidden until it arrives, so the edited one spins in alone.
    originalPic.style.visibility = 'hidden'

    // The wall goes up first, so the picture arrives onto something already moving rather than
    // having a wall appear underneath it afterwards.
    const pool = await loadReelPool()
    if (step() !== 'confirm') return
    stopReels()
    if (pool.length) {
      const deck = [...pool].sort(() => Math.random() - 0.5)
      fillReel(reelTop, -1, deck.slice(0, REEL.perReel))
      startReels()
    } else {
      reelTop.hidden = true
    }

    await spinInFromLeft(confirmPic, TIMELINE.spin)
    if (step() !== 'confirm') return
    // ...and the camera's own picture beside it, for comparison.
    originalPic.style.visibility = ''
    rise(originalPic)
    await wait(t(TIMELINE.storyLeadIn))
    if (step() !== 'confirm') return

    editVerdict.show()
    adjustVerdict.show()
  },

  // Not about the visitor's picture at all. It is about the room: everyone who stands here is
  // asked the same question twice, and the two answers are rarely the same.
  async reality() {
    clearBeats()
    resetBtn.classList.add('waiting')
    const alive = () => step() === 'reality'

    await fadeIn(realityLead, REALITY_LEAD)
    if (!alive()) return
    await wait(t(TIMELINE.realityHold))
    if (!alive()) return

    await showAnswers()
    if (!alive()) return

    resetBtn.classList.remove('waiting')
    rise(resetBtn)
  },

}

/** Advance to the next step, or wrap back to the camera from the last one. */
function nextStep() {
  const next = STEPS[stepIndex + 1]
  if (next) goToStep(next.id)
  else reset()
}

// ── 1. camera ───────────────────────────────────────────────────────────────

// The shutter sound, timed so that it ends as the flash does. It is longer than the flash, so it
// starts during the countdown, and the flash is then fired off the sound rather than the other
// way round: the photograph can be held up waiting for the camera to reach its full size, and a
// flash that kept its own time would drift away from a sound that had already started.
const FLASH_MS = 460 // .flash.go's animation in app.css
const SHUTTER_FALLBACK_S = 1.512 // the file's length, until the browser has read it for itself
const shutterSound = new Audio(shutterSoundUrl)
shutterSound.preload = 'auto'
// When the sound now playing will end, on the performance clock. 0 when none is. A guess when
// play() is asked for, corrected once the sound is actually coming out, which is a few tens of
// milliseconds later.
let shutterEndsAt = 0
shutterSound.addEventListener('playing', () => {
  if (!shutterEndsAt) return
  shutterEndsAt = performance.now() + (shutterSound.duration - shutterSound.currentTime) * 1000
})

function playShutter() {
  const length = Number.isFinite(shutterSound.duration) ? shutterSound.duration : SHUTTER_FALLBACK_S
  shutterSound.currentTime = 0
  shutterEndsAt = performance.now() + length * 1000
  // Refused without a gesture on the page, which only a ?step= jump can manage. Silence then.
  shutterSound.play().catch(() => {
    shutterEndsAt = 0
  })
}

function stopShutter() {
  shutterSound.pause()
  shutterEndsAt = 0
}

async function runCountdown() {
  // A borrowed picture counts as something to photograph; without the second half of this the
  // shutter on a camera-less machine looked alive and did nothing at all.
  if ((!feed.videoWidth && !standingIn) || step() !== 'camera') return
  shutter.disabled = true
  shooting = true
  // Up to 4K now, so the switch happens while the visitor is still counting, not after.
  primePhotoSize()

  // The sound starts when it has to for its end to meet the end of the flash, if the flash
  // fires the moment the count runs out — which it does unless the camera keeps it waiting.
  const length = Number.isFinite(shutterSound.duration) ? shutterSound.duration : SHUTTER_FALLBACK_S
  const tick = t(TIMELINE.countdownTick)
  const count = TIMELINE.countdownFrom * tick
  later(Math.max(0, count + FLASH_MS - length * 1000), playShutter)

  // Each number on the clock from when the count began, not from the last one: five waits in a
  // row each start a little late, and that adds up to a flash audibly behind its sound.
  const began = performance.now()
  for (let n = TIMELINE.countdownFrom, k = 1; n > 0; n--, k++) {
    countdownEl.textContent = String(n)
    pop(countdownEl)
    await wait(Math.max(0, began + k * tick - performance.now()))
  }
  countdownEl.textContent = ''
  takePhoto()
}

async function takePhoto() {
  // The photograph waits for the switch up to its size, if it has not finished — usually it
  // has, a countdown being long enough to reopen a camera in.
  if (!standingIn) await primePhotoSize()

  // The flash ends with the sound: fired as long before the sound's end as the flash lasts. A
  // camera slow enough to have kept the photograph past that point gets its flash straight away.
  if (shutterEndsAt) {
    const lead = shutterEndsAt - FLASH_MS - performance.now()
    shutterEndsAt = 0
    if (lead > 0) await wait(lead)
  }

  flash.classList.remove('go')
  void flash.offsetWidth
  flash.classList.add('go')

  // With no camera it is the borrowed picture that gets taken. No rotation and no crop: both
  // of those describe a bracket this picture was never on.
  frame = standingIn
    ? frameFromImage(standIn, CAPTURE_EDGE)
    : await captureWithDenoise()
  // What the camera gave and what was kept of it. The one number that says whether a better
  // camera is actually being used, or whether it is being asked for 720p and obliging.
  if (frame) {
    setInfo(
      'capture',
      `camera ${feed.videoWidth}x${feed.videoHeight} -> kept ${frame.width}x${frame.height}` +
        ` (${((frame.width * frame.height) / 1e6).toFixed(1)} MP)`
    )
    // What the opening levels are about to multiply the sensor by. The one number that says
    // whether a grainy picture is the camera or this code stretching it.
    setInfo('levels gain', levelsGain(frame.rest).map((g) => `${g.toFixed(2)}x`).join('  '))
  }
  if (!frame) {
    restorePreviewSize()
    shutter.disabled = false
    shooting = false
    return
  }

  // Freeze the viewfinder while the photo is handed on; a live frame still moving under a
  // still picture reads as a fault.
  feed.pause()
  // The picture is taken; nothing needs 4K until the next one.
  restorePreviewSize()
  shooting = false

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
  { block: true, text: 'The result is an image that approximates what you see with your eyes.' },
]

const ADJUST_STORY = [
  { text: 'You used the camera to capture real data. That data got sorted into three colors with a filter.' },
  { block: true, text: 'Astrophotographers isolate data using filters to focus on specific objects.' },
]

// ── the filter wheel ────────────────────────────────────────────────
//
// The point it is making: a camera on Earth splits light into red, green and blue and stops
// there, which is the first filter on this wheel. An astrophotographer puts a different piece
// of glass in the way — one that passes a single line of the spectrum and nothing else — and
// takes a separate picture through each. The wheel turns one filter at a time, and whatever is
// behind the glass comes through it changed, so the picture changes inside the filter and
// nowhere else.
//
// It is drawn very large on purpose: one filter covers the right-hand quarter of the
// photograph, edge to edge, and the rest of it runs off the screen. A visitor sees a piece of
// glass in front of the picture rather than a diagram of one.
//
// Red, green and blue, because that is what these filters do. They were named for the elements
// whose lines they pass — H\u03B1, OIII, SII, or Hydrogen, Oxygen and Sulfur in plainer words — and
// that reads as the glass sorting light by what it came off, which is not what a filter does at
// all. A filter passes a band of light and stops the rest; which elements happen to glow in that
// band is the astronomer's business, not the glass's.
//
// RGB is still the first stop, and now it is the sum of the three that follow it: the camera the
// visitor just used, taking all three at once, against three pieces of glass that each take one.
//
// `pass` is a backdrop-filter, and what it has to do is keep the brightness and throw away
// everything but one band. Everything after grayscale here is one linear map, so grey goes in and
// one fixed colour times that grey comes out — and the brightness in front of it is chosen to put
// the brightest pixel exactly at the top of its channel, so nothing clips anywhere on the ramp
// and the picture's own shading survives. Get that wrong in either direction and the glass either
// crushes to black or blows out: a nearly white pixel has no colour left to push, so an
// over-saturated chain turns it yellow whatever band it was meant to be. The numbers are solved,
// not picked — measured on a mid grey, each of these comes out on its own channel with nothing at
// all in the other two.
const FILTERS = [
  { name: 'RGB', sub: 'your camera', pass: 'saturate(1.06)' },
  { name: 'Red', sub: '620\u2013750 nm', pass: 'grayscale(1) brightness(0.173) sepia(1) hue-rotate(311deg) saturate(15.25)' },
  { name: 'Green', sub: '495\u2013570 nm', pass: 'grayscale(1) brightness(0.59) sepia(1) hue-rotate(71deg) saturate(5.5)' },
  { name: 'Blue', sub: '450\u2013495 nm', pass: 'grayscale(1) brightness(0.059) sepia(1) hue-rotate(201.5deg) saturate(51)' },
]
const WHEEL_STEP = 360 / FILTERS.length
const WHEEL_SWING = 900 // the swing from one filter to the next; matches the CSS transition
const WHEEL_WAIT = 4200 // how long the arrows get on their own before the wheel demonstrates
const WHEEL_DWELL = 3400 // and how long each filter then sits in the gate
// How much of the photograph the filter in the gate covers, by area. It was a quarter of the
// width at the widest point of the arc, which came to about a sixth of the picture.
const WHEEL_COVER = 0.3

/**
 * How far into the picture the arc has to reach for the filter to cover `cover` of it.
 *
 * The filter in the gate is a circular segment whose chord is the picture's full height, so its
 * area follows from how deep it reaches. That has no closed-form inverse; halving the interval
 * forty times is far more precise than a pixel.
 */
function bandForCover(w, h, cover) {
  const half = h / 2
  const area = (band) => {
    const rad = (band * band + half * half) / (2 * band)
    return rad * rad * Math.acos((rad - band) / rad) - (rad - band) * half
  }
  let lo = 1
  let hi = w
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (area(mid) < cover * w * h) lo = mid
    else hi = mid
  }
  return lo
}

// ── the stars round the wheel ──────────────────────────────────────
//
// A nod to what the filters are for, without claiming anything about the visitor's picture: a
// field of stars in the space round it, each with a temperature and so a colour, and the filter
// in the gate decides which of them come through. Through RGB every star shows in its own colour,
// as a camera takes them all at once. Through Red the cool stars stand out and the hot ones drop
// away, through Blue the reverse, and through Green the Sun-like ones in between — the Sun's
// light peaks in the green. The same sky, a different population of it at every filter, which is
// what isolating data with a filter means.
//
// Drawn, not photographed, and true as far as it goes: real stars are these three colours, in
// roughly these numbers, and a filter passes the ones that are bright in its band. There are no
// green stars. Under the Green filter it is the white-yellow ones, tinted by the glass.
//
// Kept steady and hard-edged for the exhibit panel's sake: no twinkle, no glow, and a star that a
// filter does not pass goes out entirely rather than to a faint grey — near black is exactly
// where that panel shimmers.
const STAR_COUNT = 300
const STAR_KINDS = [
  // `flux` is how bright each kind is in the red, green and blue bands, as a share of its best.
  // `temp` is the range of surface temperatures, in kelvin, that gives a star that colour.
  { share: 0.38, natural: '#ffc49a', flux: [1, 0.55, 0.2], temp: [2800, 4800] }, // cool: red and orange
  { share: 0.37, natural: '#fff3e2', flux: [0.7, 1, 0.7], temp: [5300, 6800] }, // Sun-like: white and yellow
  { share: 0.25, natural: '#c4d8ff', flux: [0.25, 0.55, 1], temp: [9500, 24000] }, // hot: blue-white
]
/** What a filter makes of a star that bright in its band: fully lit, partly lit, or not at all. */
const passed = (flux) => (flux >= 0.9 ? 1 : flux >= 0.65 ? 0.6 : 0)
// How much a star the filter passes in full swells, so the ones it picks out read as picked out.
const STAR_PICKED = 1.45

const starfield = $('starfield')
const stars = []

/** Scatter the stars, once. Each carries its look under every filter, so a swing is just a class. */
function buildStars() {
  if (stars.length) return
  for (let n = 0; n < STAR_COUNT; n++) {
    let pick = Math.random()
    const kind = STAR_KINDS.find((k) => (pick -= k.share) < 0) ?? STAR_KINDS[0]
    // Most stars faint, a few bright, as in any patch of sky. Never so faint as to sit in the
    // panel's near-black range.
    const glow = 0.72 + 0.28 * Math.random() ** 3
    const el = document.createElement('i')
    el.className = 'star'
    const x = Math.random()
    const y = Math.random()
    const s = 1.5 + 2 * Math.random() ** 2.5
    el.style.left = `${(x * 100).toFixed(2)}%`
    el.style.top = `${(y * 100).toFixed(2)}%`
    el.style.setProperty('--s', s.toFixed(2))
    el.style.setProperty('--c0', kind.natural)
    el.style.setProperty('--o0', glow.toFixed(2))
    const through = kind.flux.map(passed)
    CHANNELS.forEach((ch, i) => {
      el.style.setProperty(`--c${i + 1}`, ch.accent)
      el.style.setProperty(`--o${i + 1}`, (glow * through[i]).toFixed(2))
      el.style.setProperty(`--k${i + 1}`, through[i] === 1 ? STAR_PICKED : 1)
    })
    starfield.append(el)
    const [lo, hi] = kind.temp
    const temp = Math.round((lo + (hi - lo) * Math.random()) / 100) * 100
    stars.push({ el, n, x, y, s, glow, through, temp })
  }
  starfield.append(starNotes)
}

// ── what the readouts say about a star ──
//
// Engineering-style callouts on three of the stars each colour filter picks out. Made up only
// where nothing real could be meant: the catalogue numbers are this field's own, in a form no
// real catalogue uses. Everything else is true of the star as drawn — its temperature is the one
// that gave it its colour, the class is what that temperature is called, the band is the filter's,
// and the signal is how bright the star is drawn through it.
const NOTES_PER_FILTER = 3
const starNotes = document.createElement('div')
starNotes.className = 'star-notes'

/** The Morgan–Keenan class a temperature falls in. */
const spectralClass = (k) => (k < 3700 ? 'M' : k < 5200 ? 'K' : k < 6000 ? 'G' : k < 7500 ? 'F' : k < 10000 ? 'A' : 'B')

function noteLines(star, f) {
  // 7919 is prime to 9000, so every star in the field gets a different number.
  const id = `SKY-${1000 + ((star.n * 7919) % 9000)}`
  const filter = FILTERS[f]
  return [
    `◆ TGT ${id}`,
    `CLASS ${spectralClass(star.temp)} · ${star.temp.toLocaleString('en-US')} K`,
    `${filter.name} ${filter.sub} · SIG ${star.glow.toFixed(2)}`,
  ]
}

/**
 * Lay the callouts out for every filter, clear of the picture, the edges and each other.
 *
 * Measured, so it is redone whenever the screen or the picture changes size. A star with no room
 * round it for a readout is passed over for another the same filter picks out.
 */
function layoutNotes() {
  starNotes.replaceChildren()
  const host = starfield.getBoundingClientRect()
  const g = adjustSplit.getBoundingClientRect()
  if (!host.width || !g.width) return
  const W = host.width
  const H = host.height
  const pad = W * 0.025
  const keep = H * 0.02
  const group = { l: g.left - host.left - keep, r: g.right - host.left + keep, t: g.top - host.top - keep, b: g.bottom - host.top + keep }
  const hits = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t

  const svgNS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNS, 'svg')
  svg.setAttribute('class', 'note-lines')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  starNotes.append(svg)

  for (let f = 1; f < FILTERS.length; f++) {
    const placed = []
    const pool = stars
      .filter((st) => st.through[f - 1] === 1 && !st.el.classList.contains('covered'))
      .sort(() => Math.random() - 0.5)

    // Spread round the screen rather than bunched: a readout this near another's star is passed
    // over for one further off.
    const apart = Math.max(W, H) * 0.16
    const marked = []
    for (const star of pool) {
      if (placed.length >= NOTES_PER_FILTER) break
      const sx = star.x * W
      const sy = star.y * H
      if (marked.some(([mx, my]) => Math.hypot(mx - sx, my - sy) < apart)) continue
      const note = document.createElement('div')
      note.className = 'note'
      note.dataset.f = String(f)
      note.style.setProperty('--acc', CHANNELS[f - 1].accent)
      for (const [i, text] of noteLines(star, f).entries()) {
        const line = document.createElement('span')
        line.textContent = text
        if (i === 0) line.className = 'note-id'
        note.append(line)
      }
      starNotes.append(note)
      const lw = note.offsetWidth
      const lh = note.offsetHeight

      // The ring sits just outside the star at its picked-out size.
      const ring = ((star.s * innerWidth) / 2000) * STAR_PICKED + W * 0.004
      const rise = W * 0.024
      const inward = sx < W / 2 ? 1 : -1
      let spot = null
      for (const dir of [inward, -inward]) {
        for (const vert of sy < H * 0.2 ? [1, -1] : [-1, 1]) {
          const ex = sx + dir * rise
          const ey = sy + vert * rise
          const hx = ex + dir * (lw + W * 0.004)
          const box = {
            l: Math.min(sx, ex, hx) - 6,
            r: Math.max(sx, ex, hx) + 6,
            t: Math.min(sy, ey - lh - 6) - 6,
            b: Math.max(sy, ey) + 6,
          }
          if (box.l < pad || box.r > W - pad || box.t < pad || box.b > H - pad) continue
          if (hits(box, group) || placed.some((p) => hits(box, p))) continue
          spot = { dir, vert, ex, ey, hx, box }
          break
        }
        if (spot) break
      }
      if (!spot) {
        note.remove()
        continue
      }
      placed.push(spot.box)
      marked.push([sx, sy])

      note.style.left = `${Math.min(spot.ex, spot.hx)}px`
      note.style.top = `${spot.ey - lh - 6}px`
      note.style.textAlign = spot.dir < 0 ? 'right' : 'left'

      const ringEl = document.createElementNS(svgNS, 'circle')
      ringEl.setAttribute('cx', sx)
      ringEl.setAttribute('cy', sy)
      ringEl.setAttribute('r', ring)
      const lead = document.createElementNS(svgNS, 'polyline')
      // From the edge of the ring, out along the diagonal, then along under the readout.
      const off = ring / Math.SQRT2
      lead.setAttribute('points', `${sx + spot.dir * off},${sy + spot.vert * off} ${spot.ex},${spot.ey} ${spot.hx},${spot.ey}`)
      for (const el of [ringEl, lead]) {
        el.setAttribute('pathLength', '1')
        el.setAttribute('class', el === ringEl ? 'note-ring' : 'note-line')
        el.dataset.f = String(f)
        svg.append(el)
      }
    }
  }
}

/**
 * Leave the picture and its paragraph clear.
 *
 * Measured rather than assumed, because the group is centred and its size is the photograph's,
 * which is whatever shape the camera made it.
 */
function clearStarsOffPicture() {
  const host = starfield.getBoundingClientRect()
  const group = adjustSplit.getBoundingClientRect()
  if (!host.width || !group.width) return
  const margin = host.height * 0.02
  for (const { el, x, y } of stars) {
    const px = host.left + x * host.width
    const py = host.top + y * host.height
    el.classList.toggle(
      'covered',
      px > group.left - margin && px < group.right + margin && py > group.top - margin && py < group.bottom + margin
    )
  }
}

/** The sky through whichever filter is in the gate. */
function showStars(filter) {
  starfield.dataset.f = String(filter)
}

let wheelAt = 0
let wheelLive = false
let wheelTimer = 0
let wheelGate = 0
let wheelReach = 400 // how far a finger travels to bring the next filter round
let wheelDrag = null

/**
 * Put the wheel where the photograph actually ended up.
 *
 * One filter reaches a quarter of the way into the picture at the middle of its arc and touches
 * the top and bottom corners of that band — which fixes its size: for a circle, a bulge of
 * `band` across a chord of the picture's full height means a radius of
 * (band² + (height/2)²) / 2band. That comes out much wider than the screen, and the rest of
 * the disc simply runs off it, which is what a filter in front of a camera looks like.
 *
 * The hub sits far off to the right so the gate — the nine o'clock position — lands on that
 * band, and the filters travel almost straight up and down past it.
 */
function placeWheel() {
  const pic = adjustPic.getBoundingClientRect()
  if (!pic.width) return

  const half = pic.height / 2
  const band = Math.round(bandForCover(pic.width, pic.height, WHEEL_COVER))
  const rad = Math.round((band * band + half * half) / (2 * band))
  // Just clear of touching: a wheel of n discs of radius rad needs rad / sin(pi/n) between the
  // hub and each centre for them not to overlap.
  const orbit = Math.round((rad / Math.sin(Math.PI / FILTERS.length)) * 1.04)

  filterWheel.style.setProperty('--d', `${rad * 2}px`)
  filterWheel.style.setProperty('--band', `${band}px`)
  filterWheel.style.setProperty('--rim', `${Math.max(10, Math.round(band * 0.085))}px`)
  filterWheel.style.setProperty('--r', `${orbit}px`)
  filterWheel.style.setProperty('--hub-x', `${Math.round(pic.width - band + rad + orbit)}px`)
  filterWheel.style.setProperty('--hub-y', `${Math.round(half)}px`)

  // Geared, not literal. The rim of a wheel this size travels thousands of pixels between
  // filters and no finger on a screen can follow it; a quarter of the picture's height per
  // filter is a swipe.
  wheelReach = Math.max(240, Math.round(pic.height / 4))
}

function buildWheel() {
  filterWheel.querySelectorAll('.filter').forEach((el) => el.remove())
  FILTERS.forEach((f, i) => {
    const el = document.createElement('div')
    el.className = 'filter'
    el.style.setProperty('--a', `${-i * WHEEL_STEP}deg`)
    el.style.setProperty('--pass', f.pass)
    el.dataset.i = String(i)

    const name = document.createElement('b')
    name.textContent = f.name
    const sub = document.createElement('small')
    sub.textContent = f.sub
    const glass = document.createElement('span')
    glass.className = 'filter-glass'

    el.append(glass, name, sub)
    filterWheel.append(el)
  })
  filterWheel.style.setProperty('--turn', `${wheelAt * WHEEL_STEP}deg`)
  markGate(wheelAt)
}

/**
 * Which one is in the gate. Filter i is there whenever the wheel has turned i steps.
 *
 * `keep` leaves whatever else is already lit alone, which is what makes a swing seamless: the
 * filter arriving is coloured before it starts moving and the one leaving keeps its colour until
 * it has gone, so there is never a frame with clear glass across the picture.
 */
function markGate(at, keep = false) {
  const i = ((Math.round(at) % FILTERS.length) + FILTERS.length) % FILTERS.length
  for (const el of filterWheel.querySelectorAll('.filter')) {
    const mine = Number(el.dataset.i) === i
    if (mine || !keep) el.classList.toggle('in-gate', mine)
  }
  // The sky changes with the glass, at the same moment.
  showStars(i)
}

/** Whether a swipe should be doing anything at all. */
function wheelRunning() {
  return wheelLive && step() === 'adjust' && adjustSplit.dataset.phase === 'ask'
}

function startWheel() {
  stopWheel()
  wheelLive = true
  wheelAt = 0
  placeWheel()
  buildWheel()
  buildStars()
  clearStarsOffPicture()
  layoutNotes()
  starfield.classList.add('on')
  filterWheel.classList.remove('touched')
  // Nobody swipes a photograph unprompted. The arrows get a while on their own; if they are not
  // taken up the wheel turns itself, so the point is still made to a visitor who only watches.
  wheelTimer = setTimeout(function attract() {
    if (!wheelRunning()) return stopWheel()
    wheelAt++
    settleWheel()
    wheelTimer = setTimeout(attract, t(WHEEL_DWELL))
  }, t(WHEEL_WAIT))
}

/** Swing to whichever filter wheelAt now names, lit the whole way there. */
function settleWheel() {
  filterWheel.style.setProperty('--turn', `${wheelAt * WHEEL_STEP}deg`)
  // Lit before it moves, not when it lands. Waiting for the swing to finish and colouring the
  // glass then is a second of clear glass in the middle of the picture, which reads as the
  // exhibit thinking about it.
  markGate(wheelAt, true)
  clearTimeout(wheelGate)
  // And the one that left gives its colour up only once it is gone.
  wheelGate = setTimeout(() => markGate(wheelAt), t(WHEEL_SWING) + 60)
}

/** The first touch ends the demonstration. From there the wheel is the visitor's. */
function takeWheel() {
  clearTimeout(wheelTimer)
  wheelTimer = 0
  filterWheel.classList.add('touched')
}

function wheelDown(e) {
  if (!wheelRunning() || wheelDrag) return
  wheelDrag = { id: e.pointerId, y0: e.clientY, y: e.clientY, at0: wheelAt, ts: performance.now(), v: 0, moved: 0 }
  takeWheel()
  clearTimeout(wheelGate)
  filterWheel.classList.add('dragging')
  try {
    adjustSplit.setPointerCapture(e.pointerId)
  } catch {}
}

function wheelMove(e) {
  if (!wheelDrag || e.pointerId !== wheelDrag.id) return
  // Up is forwards, because at nine o'clock that is the way the rim of a wheel turning
  // clockwise actually travels.
  const by = (wheelDrag.y0 - e.clientY) / wheelReach
  wheelDrag.moved = Math.max(wheelDrag.moved, Math.abs(wheelDrag.y0 - e.clientY))
  filterWheel.style.setProperty('--turn', `${(wheelDrag.at0 + by) * WHEEL_STEP}deg`)
  // Under a finger the tint follows along, changing as each filter passes the gate: that the
  // picture changes with the glass is the thing being said, and this is where it is said best.
  markGate(wheelDrag.at0 + by)

  const now = performance.now()
  if (now > wheelDrag.ts) {
    wheelDrag.v = (wheelDrag.y - e.clientY) / (now - wheelDrag.ts)
    wheelDrag.ts = now
    wheelDrag.y = e.clientY
  }
}

function wheelUp(e) {
  const d = wheelDrag
  if (!d || e.pointerId !== d.id) return
  wheelDrag = null
  filterWheel.classList.remove('dragging')
  // Take the transition back before the value changes, or the snap happens in one frame.
  void filterWheel.offsetWidth

  const by = (d.y0 - e.clientY) / wheelReach
  // A flick carries on past the finger, the way a wheel with any mass does.
  const flick = Math.abs(d.v) > 1.2 ? Math.sign(d.v) : 0
  let by_ = Math.round(by) + flick
  // Rounding alone would mean a short push moves nothing: half a filter is a drag of well over
  // two hundred pixels, and a visitor who pushes it fifty and watches it settle back where it
  // was has been told the thing does not work. Any deliberate push is worth one filter.
  if (!by_) by_ = Math.sign(by) || 1
  // And a tap is neither a flick nor a drag, but it is still someone asking for the next one.
  wheelAt = d.moved < 12 ? wheelAt + 1 : d.at0 + by_
  settleWheel()
}

// The swipe is listened for across the whole screen rather than on the wheel itself: the thing
// that moves is at the edge of the picture, and a visitor who has just been told to try
// something reaches for the middle of it.
adjustSplit.addEventListener('pointerdown', wheelDown)
adjustSplit.addEventListener('pointermove', wheelMove)
adjustSplit.addEventListener('pointerup', wheelUp)
adjustSplit.addEventListener('pointercancel', wheelUp)

function stopWheel() {
  clearTimeout(wheelTimer)
  clearTimeout(wheelGate)
  wheelTimer = 0
  wheelGate = 0
  wheelDrag = null
  wheelLive = false
  filterWheel.classList.remove('dragging')
  // The sky belongs to the wheel, and goes with it.
  starfield.classList.remove('on')
}

// The question the piece is actually asking. Held back until a colour has been changed, so it
// is asked of something the visitor has just done rather than of something they were shown.
const REAL_ASK_BEFORE = 'Is this image '
const REAL_ASK_WORD = 'real'
const REAL_ASK_AFTER = '?'

const CONFIRM_ASK = [{ text: 'How would you like to share your sky to the gallery?' }]

const REALITY_LEAD = [
  { text: 'Your image was shared and is now part of the gallery.' },
  {
    block: true,
    text:
      'Everyone was asked if the image they took with the camera was "real" and if the ' +
      'image they edited was "real". Here are the results:',
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
  writeSegments(el, segments)
  return track(
    el.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: t(ms),
      easing: 'linear',
      fill: 'both',
    })
  ).finished.catch(() => {})
}

/** Put a line's segments into an element, with each channel's name ready to light. */
function writeSegments(el, segments) {
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

  // Each layer sends a copy of itself into the frame, and the picture is built out of the three
  // the visitor has just been shown...
  for (let i = 0; i < CHANNELS.length; i++) {
    if (!alive()) return
    await flyLayerIn(i)
    await wait(t(TIMELINE.flyGap))
  }
  if (!alive()) return

  // ...and only once it is whole does the summary pop up to say what just happened.
  await pop(storyAfterEl)?.finished.catch(() => {})
  if (!alive()) return

  // The picture is made and explained, and only now is there a way on. The question of whether
  // it is real waits for the share screen, where it is asked beside the edited one.
  nextBtn.classList.remove('waiting')
  pop(nextBtn)
}

/** Put every step that says something back to the empty screen it starts from. */
function clearBeats() {
  ;[storyEl, storyAfterEl, adjustStoryEl, noticeAsk, confirmAsk, realityLead].forEach((el) =>
    el.replaceChildren()
  )
  document.querySelectorAll('.channel, .chan-layer').forEach((el) => el.classList.remove('in'))
  slidersTitle.classList.remove('in')
  ;[nextBtn, coloursBtn, submitBtn, ...SHARE_BTNS, resetBtn].forEach((b) =>
    b.classList.remove('waiting')
  )
  coloursBtn.disabled = false
  coloursPop?.cancel()
  coloursPop = null
  editVerdict.clear()
  adjustVerdict.clear()
  stopReels()
  stopWheel()
  for (const el of [confirmPic, originalPic, originalCol, editedCol]) el.style.visibility = ''
  fliers.replaceChildren()
  realityCharts.hidden = true
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

// ── a strip of the wall, above the question ───────────────────────────────────
//
// The share question is easier to answer with the thing it is about already on screen, so the
// curated pictures run past above it, leftwards. Share one and a space opens in the strip for
// the visitor's own.
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

/** Set the strips running. Each plays forwards; the keyframes carry the direction. */
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
  reelTop.hidden = false
  reelTop.querySelector('.reel-track')?.replaceChildren()
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
 * `drawPrint` paints the picture that lands in the space, whichever of the two it is.
 */
async function joinTheWall(el, drawPrint) {
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
  drawPrint(print)
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
    await wait(t(TIMELINE.chartIn))
  }
  // Both controls on this card are new, so both say so. They are told apart by kind rather
  // than by timing — the swatch knocks a ring out of itself, the handles slide sideways — and
  // each stops for good the moment it has been used.
  bigEditors.forEach((e) => {
    e.setAsking(true)
    e.setPulsing(true)
  })
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
    // The way on arrives with the first change. Whether the result is real is asked on the
    // next screen, beside the original.
    submitBtn.classList.remove('waiting')
    pop(submitBtn)
    bigEditors.forEach((e) => e.setAsking(false))
  }

  queueDraw(src)
}

// The Next button's own entrance, kept so it can be called off. A finished `fill: 'both'`
// animation outranks a class — `pop` leaves opacity at 1, and adding .waiting on top of that
// hides nothing at all. This file has been caught by that four times now.
let coloursPop = null

/** Next, on the adjust screen: bring up the colours. */
async function onColours() {
  if (step() !== 'adjust' || coloursBtn.disabled) return
  // Disabled as well as hidden: .waiting takes the pointer events away, but a keyboard can
  // still reach a button that is merely transparent, and openColours is not re-entrant.
  coloursBtn.disabled = true
  // Cancelled before the class goes on, or the class is outranked and Next stays on screen
  // underneath Share my sky.
  coloursPop?.cancel()
  coloursPop = null
  coloursBtn.classList.add('waiting')
  // The wheel belongs to the first half of this screen; the spectra are the second half's
  // version of the same idea, and two of them at once is neither.
  stopWheel()
  await openColours()
}

// ── the answer ─────────────────────────────────────────────────────────────
//
// The exhibit asks "Is this image real?" twice, and the point is the pair: once of the picture
// the camera made on its own, and again of the same picture after the visitor has moved its
// colours somewhere the camera never put them. Each time a figure is dragged between No and
// Yes, and where it is left is the answer, as a number from 0 (no) to 1 (yes).
//
// Both go to api/answer, one row per visitor per question, when that screen is left. Each
// starts in the middle and is only reported if it was moved: an untouched scale is not a
// visitor answering "undecided", it is a visitor who walked away, and averaging the two
// together would bury the difference in exactly the number this is being kept for.

// What this visitor answered, kept for the last screen to mark them on its charts.
//
// Held here rather than read off the scales themselves: every step handler calls clearBeats on
// the way in, which puts both scales back to untouched, so by the time the Reality screen asks
// them they no longer know. This is written when the answer is reported and cleared with the
// visitor, which is exactly the life it should have.
const answered = { unedited: null, edited: null }

// No, undecided, yes. The same three the stylesheet paints the bar with, because the figure
// takes the colour of the bar under its feet and the two must agree.
const VERDICT_COLOURS = [
  [0.0, [255, 59, 48]],
  [0.5, [58, 160, 255]],
  [1.0, [34, 197, 94]],
]

/** The colour of the bar at p, which is the colour the figure standing there takes. */
function verdictColour(p) {
  let [x0, c0] = VERDICT_COLOURS[0]
  for (const [x1, c1] of VERDICT_COLOURS.slice(1)) {
    if (p <= x1 || x1 === 1) {
      const k = x1 === x0 ? 0 : (Math.min(p, x1) - x0) / (x1 - x0)
      const mix = c0.map((v, i) => Math.round(v + (c1[i] - v) * k))
      return `rgb(${mix.join(', ')})`
    }
    x0 = x1
    c0 = c1
  }
  return `rgb(${VERDICT_COLOURS.at(-1)[1].join(', ')})`
}

/**
 * Write "Is this image real?" into an element, with the word itself in three colours.
 *
 * "real" is written four times: once in the parent to hold the line's width, and once per
 * channel on top of it. The three are added together rather than painted over each other, so
 * apart you can see the colours the word is made of and together they come back to white —
 * which is the same arithmetic, and the same point, as the three layers that made the picture.
 */
function writeRealAsk(el) {
  if (el.childNodes.length) return

  const word = document.createElement('span')
  word.className = 'real-word'
  word.append(REAL_ASK_WORD)
  for (const channel of CHANNELS) {
    const layer = document.createElement('i')
    layer.textContent = REAL_ASK_WORD
    // The parent already carries the word, and these three are the same word painted again in
    // three colours. Without this the line is read out as "realrealrealreal".
    layer.setAttribute('aria-hidden', 'true')
    layer.style.setProperty('--acc', channel.accent)
    word.append(layer)
  }
  el.append(REAL_ASK_BEFORE, word, REAL_ASK_AFTER)
}

/**
 * One asking of the question, and the figure that answers it.
 *
 * `stage` is what goes in the file: which of the two pictures this answer is about. `onTouch`
 * fires the first time the figure is moved — which is what lets the screen hold its way-on
 * button back until the visitor has actually answered.
 */
function makeVerdict(stage, block, onTouch) {
  const ask = block.querySelector('.real-ask')
  block.append(scaleTpl.content.cloneNode(true))
  const scale = block.querySelector('.scale')
  const bar = block.querySelector('.scale-track')
  const figure = block.querySelector('.scale-figure')

  let at = 0.5
  let touched = false
  let sent = false
  let drag = null
  // How far the figure has walked since it last changed feet. A walk cycle belongs to distance
  // covered, not to a clock: a figure that keeps stepping while standing still is jogging on
  // the spot, and one that glides across the bar without stepping is on wheels.
  let walked = 0

  function draw() {
    scale.style.setProperty('--p', at.toFixed(4))
    scale.style.setProperty('--at', verdictColour(at))
    scale.setAttribute('aria-valuenow', at.toFixed(2))
  }

  // A stride, as a fraction of the whole bar. About forty pixels of travel at the size the bar
  // is drawn on the kiosk, against a figure some ninety wide — roughly a step per step.
  const STRIDE = 0.045

  function set(p) {
    const to = Math.min(1, Math.max(0, p))
    const moved = to - at
    at = to
    if (moved) {
      // Facing is the way it last went, and it keeps facing that way once it stops. A figure
      // that snaps back to facing right the moment it is let go reads as a sprite, not a person.
      figure?.style.setProperty('--face', moved < 0 ? '-1' : '1')
      // `while`, not `if`: one drag event can cover several strides, and a walk that can only
      // take one step per event stops stepping exactly when the finger moves fastest.
      walked += Math.abs(moved)
      while (walked >= STRIDE) {
        walked -= STRIDE
        figure?.classList.toggle('mid')
      }
    }
    draw()
    if (touched) return
    touched = true
    onTouch?.()
  }

  /** Where along the bar a point on the screen is. */
  const from = (clientX) => {
    const r = bar.getBoundingClientRect()
    return r.width ? (clientX - r.left) / r.width : 0.5
  }

  scale.addEventListener('pointerdown', (e) => {
    if (!block.classList.contains('in')) return
    drag = e.pointerId
    scale.classList.add('dragging')
    set(from(e.clientX))
    try {
      scale.setPointerCapture(e.pointerId)
    } catch {}
    e.preventDefault()
  })
  scale.addEventListener('pointermove', (e) => {
    if (drag === e.pointerId) set(from(e.clientX))
  })
  const release = (e) => {
    if (drag !== e.pointerId) return
    drag = null
    scale.classList.remove('dragging')
  }
  scale.addEventListener('pointerup', release)
  scale.addEventListener('pointercancel', release)
  // Cheap, and it is the only way anyone gets at this without a touchscreen.
  scale.addEventListener('keydown', (e) => {
    const by = { ArrowLeft: -0.05, ArrowRight: 0.05, Home: -1, End: 1 }[e.key]
    if (by === undefined) return
    set(Math.abs(by) === 1 ? (by + 1) / 2 : at + by)
    e.preventDefault()
  })

  return {
    get touched() {
      return touched
    },
    /** Where this visitor left it — read by the Reality screen to mark them on its charts. */
    get value() {
      return at
    },

    /** Ask it. */
    show() {
      writeRealAsk(ask)
      block.classList.add('in')
      draw()
      const fade = track(
        block.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: t(TIMELINE.blockFade),
          easing: 'linear',
          fill: 'both',
        })
      )
      // Let go of it once it has landed. A running opacity animation makes a stacking context,
      // and a stacking context is precisely what stops plus-lighter reaching the page behind
      // the word.
      fade.finished.then(() => fade.cancel()).catch(() => {})
    },

    /** Put it back to unasked and undecided for the next visitor. */
    clear() {
      at = 0.5
      touched = false
      sent = false
      drag = null
      walked = 0
      figure?.classList.remove('mid')
      figure?.style.setProperty('--face', '1')
      scale.classList.remove('dragging')
      block.classList.remove('in')
      ask.replaceChildren()
      draw()
    },

    /**
     * Report it, once.
     *
     * Deliberately not awaited and deliberately never in the way: a visitor pressing on must
     * not wait for a network, and an exhibit machine that cannot write the file is a thing for
     * whoever runs it to find in the debug overlay, not a thing to stop a visitor with.
     */
    send() {
      if (sent || !touched) return
      sent = true
      answered[stage] = at
      setInfo('answer', `${stage} ${at.toFixed(3)}`)
      sendAnswer({ stage, value: Number(at.toFixed(3)) })
    },
  }
}

/**
 * One row to api/answer.
 *
 * Deliberately not awaited and deliberately never in the way: a visitor pressing on must not
 * wait for a network, and an exhibit machine that cannot write the file is a thing for whoever
 * runs it to find in the debug overlay, not a thing to stop a visitor with.
 */
function sendAnswer(row) {
  const body = JSON.stringify(row)
  try {
    // A visitor who is mid-answer when the kiosk reloads still gets counted: a beacon survives
    // the page, and a fetch does not.
    if (navigator.sendBeacon?.(new URL('api/answer', location.href), new Blob([body], { type: 'application/json' }))) return
  } catch {}
  fetch('api/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true })
    .catch((err) => setInfo('answer', `not written: ${err?.message ?? err}`))
}

// Asked of the camera's own picture, and of the same picture once its colours have been moved
// somewhere the camera never put them — side by side, on the share screen. Only once both have
// been answered is the share question put.
const editVerdict = makeVerdict('unedited', editVerdictBlock, () => askToShare())
const adjustVerdict = makeVerdict('edited', verdictBlock, () => askToShare())

async function askToShare() {
  if (step() !== 'confirm' || !editVerdict.touched || !adjustVerdict.touched) return
  if (confirmAsk.childNodes.length) return // already asked
  await fadeIn(confirmAsk, CONFIRM_ASK)
  if (step() !== 'confirm') return
  SHARE_BTNS.forEach((btn, i) => {
    btn.classList.remove('waiting')
    pop(btn, i * 90)
  })
}

/** Report both answers, each once and only if it was given. */
function sendVerdicts() {
  editVerdict.send()
  adjustVerdict.send()
}

// The kiosk is never closed, but it is reloaded, and a visitor mid-answer when that happens is
// still a visitor who answered.
addEventListener('pagehide', sendVerdicts)

// The picture as the camera made it: its own levels, and each channel shown in its own colour.
// The levels are the ones the photograph opened on, which the visitor may since have moved.
const ORIGINAL_TINTS = CHANNELS.map((c) => hueTint(c.hue))
const originalLuts = () => frame.rest.map((l) => levelsLut(l.black, l.white))


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

// Which picture this visitor shared, for the last screen to mark on its chart. Null if neither.
let sharedPick = null

/**
 * Share one of the two pictures: `edited`, or `original` as the camera made it.
 *
 * Deliberately not awaited. A visitor pressing Share must never wait on a network, and never
 * has to: the store keeps the picture on this device if the wall cannot be reached, so the turn
 * carries on either way. Where it actually went goes to the debug overlay, because that is a
 * question for whoever is running the exhibit and not for the person standing here.
 */
async function onShare(pick) {
  if (step() !== 'confirm') return
  SHARE_BTNS.forEach((b) => (b.disabled = true))

  const edited = pick === 'edited'
  const luts = edited ? lutsNow() : originalLuts()
  const shownTints = edited ? tints() : ORIGINAL_TINTS
  publishToWall({
    image: compositeURL(downscaleFrame(frame, WALL_EDGE), luts, shownTints),
    levels: edited ? levels.map((l) => ({ ...l })) : frame.rest.map((l) => ({ black: l.black, white: l.white })),
    shownHue: edited ? [...shownHue] : CHANNELS.map((c) => c.hue),
  }).then(
    (r) => setInfo('shared', `${pick} ${r.kept === 'wall' ? 'to the wall' : `${r.kept} — ${r.why}`}`),
    (err) => setInfo('shared', `failed: ${err.message}`)
  )
  sharedPick = pick
  sendAnswer({ stage: 'shared', value: edited ? 1 : 0 })

  // The other picture, the scales and the question step back, so the one going on the wall is
  // the only thing moving.
  const going = edited ? confirmPic : originalPic
  const staying = edited ? originalCol : editedCol
  const fade = [staying, editVerdictBlock, verdictBlock, confirmAsk].map((el) =>
    track(el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: t(320), easing: 'linear', fill: 'both' }))
  )
  await fade[0].finished.catch(() => {})
  if (step() !== 'confirm') return

  // Into a space on the wall if there is a wall; off to the side if the folder is empty.
  const joined = await joinTheWall(going, (c) => drawComposite(c, thumbFrame ?? viewFrame ?? frame, luts, shownTints))
  if (!joined) await spinAwayRight(going, TIMELINE.spinOut)
  goToStep('reality')
}

/**
 * Don't share.
 *
 * The pictures fall rather than cutting away. It is the one moment in the piece where something
 * a visitor made is discarded, and letting it go quietly is worth the two and a half seconds.
 */
async function onNo() {
  if (step() !== 'confirm') return
  SHARE_BTNS.forEach((b) => (b.disabled = true))
  await Promise.all([featherDown(confirmPic, TIMELINE.feather), featherDown(originalPic, TIMELINE.feather)])
  reset()
}

// ── 4. what the room has answered ─────────────────────────────────

const ANSWER_CHARTS = [
  { stage: 'unedited', title: 'the camera’s own picture' },
  { stage: 'edited', title: 'the one the visitor changed' },
]

/**
 * One chart: a count of everybody's answers across the scale they gave them on.
 *
 * Linear, not the log the photo histograms use. A photo's histogram is dominated by a few huge
 * bins and a linear plot flattens the rest into the axis; a day of answers is tens, not
 * millions, and log would flatten the difference between "a few people" and "nearly everybody"
 * — which is the entire thing this chart exists to show.
 */
function drawAnswers(canvas, counts) {
  const box = canvas.getBoundingClientRect()
  if (!box.width) return
  const dpr = Math.min(2, devicePixelRatio || 1)
  canvas.width = Math.round(box.width * dpr)
  canvas.height = Math.round(box.height * dpr)

  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const w = box.width
  const h = box.height
  ctx.clearRect(0, 0, w, h)

  const peak = Math.max(1, ...counts)
  const slot = w / counts.length
  const gap = Math.min(6, slot * 0.18)

  counts.forEach((n, i) => {
    if (!n) return
    const share = n / peak
    // A floor, so that one person is a mark on the wall rather than nothing at all.
    const bar = Math.max(4, share * (h - 14))
    ctx.fillStyle = verdictColour((i + 0.5) / counts.length)
    // Taller and brighter where more people said it: height alone reads as a shape, and the
    // exhibit is asking the room a question, not plotting it.
    ctx.globalAlpha = 0.45 + 0.55 * share
    ctx.fillRect(i * slot + gap / 2, h - bar, slot - gap, bar)
  })
  ctx.globalAlpha = 1
}

/**
 * Keep the "you" tag inside the chart.
 *
 * It is centred on its line, and a line at either end of the scale would take half of it past
 * the edge of the well, which is clipped. This pushes it back by exactly as much as it hangs
 * over — measured rather than guessed, because how far that is depends on how wide the word
 * came out at this screen's size.
 */
function nudgeTag(chart, you, at) {
  const tag = you.querySelector('b')
  tag.style.setProperty('--nudge', '0px')
  const plot = chart.querySelector('.answer-plot').getBoundingClientRect()
  const box = tag.getBoundingClientRect()
  if (!plot.width || !box.width) return

  const edge = 6
  const over = Math.max(0, plot.left + edge - box.left) + Math.min(0, plot.right - edge - box.right)
  tag.style.setProperty('--nudge', `${Math.round(over)}px`)
}

/**
 * Bring up what everyone has answered, and mark where this visitor stood on each.
 *
 * The summary is asked for rather than kept: the answer this visitor has just given is one of
 * the rows in it, and by this screen it has been written.
 */
async function showAnswers() {
  let data = null
  try {
    const res = await fetch('api/answer/summary', { cache: 'no-store' })
    if (res.ok) data = await res.json()
  } catch (err) {
    setInfo('answers', `not read: ${err?.message ?? err}`)
  }

  realityCharts.hidden = false

  for (const { stage } of ANSWER_CHARTS) {
    const chart = realityCharts.querySelector(`[data-stage="${stage}"]`)
    if (!chart) continue
    const counts = data?.counts?.[stage] ?? new Array(data?.bins ?? 25).fill(0)
    const total = data?.totals?.[stage] ?? 0

    chart.querySelector('.answer-count').textContent =
      total === 1 ? '1 answer so far' : `${total} answers so far`
    drawAnswers(chart.querySelector('canvas'), counts)

    // Only if they answered this one. A marker at the middle of the scale for somebody who
    // never touched it is a claim they did not make.
    const you = chart.querySelector('.answer-you')
    const mine = answered[stage]
    you.hidden = mine === null
    if (mine !== null) {
      you.style.setProperty('--you', mine.toFixed(4))
      nudgeTag(chart, you, mine)
    }
  }

  showShares(data?.shared ?? { edited: 0, original: 0 })
  setInfo('answers', `${data?.totals?.unedited ?? 0} / ${data?.totals?.edited ?? 0} · shared ${data?.totals?.shared ?? 0}`)

  // One at a time, the way the charts arrived on the screen before this one.
  for (const stage of [...ANSWER_CHARTS.map((c) => c.stage), 'shared']) {
    const chart = realityCharts.querySelector(`[data-stage="${stage}"]`)
    if (chart) rise(chart)
    await wait(t(TIMELINE.chartIn))
  }
}

/**
 * Which picture people put on the wall: two bars, edited and original, each as tall as its
 * share of the larger. The count sits on the bar, and this visitor's choice is tagged.
 */
function showShares(shared) {
  const chart = realityCharts.querySelector('[data-stage="shared"]')
  if (!chart) return
  const total = shared.edited + shared.original
  chart.querySelector('.answer-count').textContent = total === 1 ? '1 picture so far' : `${total} pictures so far`
  const peak = Math.max(1, shared.edited, shared.original)
  for (const bar of chart.querySelectorAll('.share-bar')) {
    const n = shared[bar.dataset.pick] ?? 0
    bar.style.setProperty('--share', (n / peak).toFixed(4))
    bar.querySelector('.share-n').textContent = String(n)
    bar.querySelector('.share-you').hidden = sharedPick !== bar.dataset.pick
  }
}

// ── reset ───────────────────────────────────────────────────────────────────

function reset() {
  // Starting again is leaving the share screen too, and its answers count — sent before
  // clearBeats puts both scales back to untouched.
  if (step() === 'confirm') sendVerdicts()
  cancelAll()
  stopShutter()
  shooting = false
  // A countdown nobody finished leaves the camera at the photograph's size.
  restorePreviewSize()

  frame = null
  answered.unedited = null
  answered.edited = null
  sharedPick = null
  viewFrame = null
  thumbFrame = null
  levels = null
  destroyEditors()
  clearBeats()
  document.querySelectorAll('.channel-editor').forEach((el) => el.replaceChildren())

  // Undo anything left on the elements that outlive a visitor.
  front = photoA
  feed.play().catch(() => {}) // takePhoto() paused it for the hand-off
  // A different borrowed picture for the next visitor, so a camera that stays broken all day
  // does not turn into the same photograph forty times.
  if (standingIn) useStandIn({ fresh: true })
  countdownEl.textContent = ''
  submitBtn.disabled = false
  ;[photoA, photoB, adjustCanvas, confirmCanvas, originalCanvas, ...chanLayers.querySelectorAll('.chan-img')].forEach(
    (c) => c.getContext('2d').clearRect(0, 0, c.width, c.height)
  )

  // A hard cut, blob included: "Start again" is not a transition, it is the piece ending.
  goToStep('camera', { animate: false, blob: false })
  setAspect(feed.videoWidth, feed.videoHeight)
  shutter.disabled = !feed.videoWidth && !standingIn
}

// ── nobody there ────────────────────────────────────────────────────────────
//
// A visitor who walks away mid-turn leaves the next one a screen half way through somebody
// else's picture. So on every step but the camera, a minute with nobody touching anything offers
// a fresh start, off to the side; ten seconds more and it counts down from five, says so, and
// starts over. Any touch at all, at any point before that, calls it off — somebody is there.
//
// Real seconds, not paced ones: reduced motion shortens animations, not how long a person gets.
const IDLE = { after: 60000, warn: 10000, from: 5, tick: 1000, resetting: 3000 }

const idleBox = $('idle')
const idleBtn = $('idleBtn')
const idleCount = $('idleCount')
let idleTimers = []
let idleArmedAt = 0

function idleLater(ms, fn) {
  idleTimers.push(setTimeout(fn, ms))
}

/** Put it all away: nothing offered, nothing counting. */
function idleClear() {
  idleTimers.forEach(clearTimeout)
  idleTimers = []
  idleBox.hidden = true
  idleBtn.classList.remove('warm')
  idleBtn.textContent = 'Start over'
  idleBtn.disabled = false
  idleCount.textContent = ''
}

/** Start the minute again — on every step change and every touch. Nothing on the camera step. */
function idleArm() {
  idleClear()
  idleArmedAt = performance.now()
  if (step() === 'camera') return
  idleLater(IDLE.after, idleOffer)
}

function idleOffer() {
  idleBox.classList.remove('lifted')
  idleBox.hidden = false
  // Beside the step's own buttons if there is room, and just above the dock if there is not —
  // the share step's three answers fill a narrow screen's dock almost edge to edge.
  const mine = idleBtn.getBoundingClientRect()
  const crowded = [...document.querySelectorAll('.dock-action > :not([hidden])')].some((el) => {
    const r = el.getBoundingClientRect()
    return r.width && r.right > mine.left - 12 && r.left < mine.right + 12
  })
  idleBox.classList.toggle('lifted', crowded)
  // In white, as every button arrives here, and then warm to the orange once it has landed.
  pop(idleBtn)
  idleLater(t(620), () => idleBtn.classList.add('warm'))
  idleLater(IDLE.warn, () => idleCountdown(IDLE.from))
}

function idleCountdown(n) {
  idleBtn.textContent = 'Starting over'
  if (n < 1) return idleResetting()
  idleCount.textContent = String(n)
  pop(idleCount)
  idleLater(IDLE.tick, () => idleCountdown(n - 1))
}

function idleResetting() {
  idleCount.textContent = ''
  idleBtn.textContent = 'Resetting…'
  idleLater(IDLE.resetting, () => reset())
}

// Anything a person does counts — except pressing the offer itself, which must still be there to
// be pressed when the finger lifts. Moves are only counted a few times a second: a drag fires
// dozens, and the clock does not need restarting for each.
for (const kind of ['pointerdown', 'pointermove', 'keydown', 'wheel']) {
  addEventListener(
    kind,
    (e) => {
      if (idleBox.contains(e.target)) return
      if (kind === 'pointermove' && idleBox.hidden && performance.now() - idleArmedAt < 250) return
      idleArm()
    },
    { capture: true, passive: true }
  )
}
idleBtn.addEventListener('click', () => {
  idleBtn.disabled = true
  reset()
})

// ── wiring ──────────────────────────────────────────────────────────────────

// No zooming, for the ways a touchscreen's CSS cannot stop: a trackpad pinch arrives as a wheel
// event with ctrlKey set, and Safari pinches with its own gesture events. Passive: false, or the
// browser is free to zoom before preventDefault is heard.
addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false })
for (const kind of ['gesturestart', 'gesturechange']) {
  addEventListener(kind, (e) => e.preventDefault(), { passive: false })
}

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
coloursBtn.addEventListener('click', onColours)
submitBtn.addEventListener('click', onSubmit)
yesBtn.addEventListener('click', () => onShare('edited'))
originalBtn.addEventListener('click', () => onShare('original'))
// Don't share keeps nothing: neither picture is published, and the next visitor starts clean.
noBtn.addEventListener('click', onNo)
resetBtn.addEventListener('click', reset)

boot()
