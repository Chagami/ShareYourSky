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
  CHANNELS, captureFrame, downscaleFrame, levelsLut, IDENTITY_LUT,
  drawComposite, drawChannel, drawGrey, compositeURL,
} from './imaging.js'
import { createLevels } from './levels.js'
import { initPerf, measure, count, setProbe, setInfo } from './perf.js'
import { publish as publishToWall } from './store.js'

// ── the knobs you'll actually want to turn ──────────────────────────────────

const TIMELINE = {
  countdownFrom: 5,
  countdownTick: 900, // 5-4-3-2-1 at this cadence
  freezeHold: 420, // the flash, before the photo is handed to the next step

  stepIn: 420, // a step arriving

  handlePulseAt: 260, // the handles start asking to be touched, once they have settled
  levelsSettleAt: 320, // the handles wait for the charts to land before they move...
  levelsSettle: 700, // ...then slide from the ends of the track to the channel's own range

  cameraRetryAt: 15000, // a camera that will not open is retried until it does
  shareHold: 1600, // the confirmation after sharing, before the last step is offered
  autoResetAt: 90000, // an abandoned session returns to the camera on its own
}

const CAPTURE_W = 1400 // a 2160-wide panel shows this large; 900 was visibly soft

// A sideways-mounted camera, corrected on the kiosk shortcut rather than in the code, because
// which way it is turned is a property of the bracket it is screwed to and not of the exhibit:
//   ?rot=90   ?rot=180   ?rot=270
const CAM_ROT = (() => {
  const n = Number(new URLSearchParams(location.search).get('rot') ?? 270)
  return Number.isFinite(n) ? ((Math.round(n / 90) * 90) % 360 + 360) % 360 : 0
})()

const PACE = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.3 : 1
const t = (ms) => Math.round(ms * PACE)
const EASE = 'cubic-bezier(.16, 1, .3, 1)'

const $ = (id) => document.getElementById(id)
const feed = $('feed')
const shutter = $('shutter')
const flash = $('flash')
const countdownEl = $('countdown')
const photoA = $('photoA')
const photoB = $('photoB')
const photoStack = document.querySelector('.photo-stack')
const channelsEl = $('channels')
const astroStrip = $('astroStrip')
const shareCanvas = $('shareCanvas')
const previewCanvas = $('previewCanvas')
const stepBar = $('stepBar')
const nextBtn = $('nextBtn')
const submitBtn = $('submitBtn')
const resetBtn = $('resetBtn')

/**
 * The four steps, in order. Each owns one screen and one action in the dock.
 *
 * `enter` runs when the step is opened, and is the only place a step's content is built. That
 * is what makes them separable: any of them can be opened directly with `?step=edit` without
 * running the ones before it, which is how they get worked on individually.
 */
const STEPS = [
  { id: 'camera', action: 'shutter' },
  { id: 'edit', action: 'nextBtn' },
  { id: 'share', action: 'submitBtn' },
  { id: 'astro', action: 'resetBtn' },
]
const STEP_IDS = STEPS.map((s) => s.id)


let gen = 0
let anims = []
let timers = []

let frame = null // { width, height, planes, luma, histograms, rest } — written once, read-only after
// Cheap copies for the things that redraw on every drag. At capture resolution the three
// thumbnails plus the preview would be four full-frame passes per pointermove.
let thumbFrame = null
let previewFrame = null
let levels = null // [{black, white} x3] — the only thing the visitor changes
let bigEditors = []
let front = photoA // which stacked canvas is currently showing

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
function goToStep(id, { animate = true } = {}) {
  const i = stepAt(id)
  if (i === -1) return
  stepIndex = i
  document.body.dataset.step = id

  // The dock offers one action, and it is the one this step named.
  const wanted = STEPS[i].action
  for (const btn of [shutter, nextBtn, submitBtn, resetBtn]) {
    btn.hidden = btn.id !== wanted && !(wanted === 'shutter' && btn === shutter)
  }

  // The indicator marks where we are and what has been passed.
  ;[...stepBar.children].forEach((dot, n) => {
    dot.classList.toggle('now', n === i)
    dot.classList.toggle('done', n < i)
  })

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


function setAspect(w, h) {
  if (!w || !h) return
  // On a quarter turn the displayed shape is the camera's, turned — so the ratio flips too.
  const upright = CAM_ROT === 90 || CAM_ROT === 270
  const ar = upright ? h / w : w / h
  document.documentElement.style.setProperty('--shot-ar', ar.toFixed(4))
}

// ── the photo bay: two stacked canvases, so any change can crossfade ────────

const lutsNow = () => levels.map((l) => levelsLut(l.black, l.white))
const lutsIdentity = () => [IDENTITY_LUT, IDENTITY_LUT, IDENTITY_LUT]

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
    if (step() === 'astro') {
      drawBands(only)
      drawPreview()
    } else {
      paint((c) => drawComposite(c, frame, lutsNow()))
    }
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
  const target = frame.rest[index]
  const from = { ...levels[index] }
  const g = gen
  const started = performance.now()
  const duration = t(TIMELINE.levelsSettle)

  // Named `tick`, not `step`: a local called `step` would shadow the module's step() and this
  // would silently call itself instead of asking which screen is open.
  const tick = (now) => {
    if (g !== gen) return
    // Left the editing screens mid-slide: land on the target rather than leaving it half moved.
    if (step() !== 'edit' && step() !== 'astro') {
      levels[index] = { ...target }
      bigEditors.forEach((e) => e.redraw())
      return
    }
    const p = Math.min(1, (now - started) / duration)
    const e = 1 - (1 - p) ** 5 // an ease-out close enough to the house curve
    levels[index] = {
      black: Math.round(from.black + (target.black - from.black) * e),
      white: Math.round(from.white + (target.white - from.white) * e),
    }
    onLevelsChanged(index)
    if (p < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// ── 1. live ─────────────────────────────────────────────────────────────────

async function boot() {
  initPerf()
  if (CAM_ROT) {
    document.body.dataset.rot = String(CAM_ROT)
    setInfo('rotation', `${CAM_ROT}deg (?rot=)`)
  }

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
      takePhoto().then(() => goToStep(jump))
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
 * What each step does when it is opened.
 *
 * Kept as a lookup rather than a chain of calls so that no step knows about any other. That is
 * what lets `?step=astro` work: the step builds whatever it needs from `frame` and `levels`,
 * and does not care how the visitor got there.
 */
const STEP_ENTER = {
  camera() {
    shutter.disabled = !feed.videoWidth
  },

  edit() {
    if (!frame) return
    buildChannelEditors(channelsEl, '.channel-editor')
    paint((c) => drawComposite(c, frame, lutsNow()))
    later(t(TIMELINE.levelsSettleAt), () => {
      bigEditors.forEach((_, i) => settleLevels(i))
      later(t(TIMELINE.levelsSettle + TIMELINE.handlePulseAt), () =>
        bigEditors.forEach((e) => e.setPulsing(true))
      )
    })
  },

  share() {
    if (!frame) return
    drawComposite(shareCanvas, previewFrame ?? frame, lutsNow())
    submitBtn.disabled = false
    $('shareHint').textContent = 'This goes up on the gallery wall'
  },

  astro() {
    if (!frame) return
    buildChannelEditors(astroStrip, '.band-editor')
    drawBands()
    drawPreview()
    later(t(TIMELINE.levelsSettleAt), () =>
      bigEditors.forEach((e) => e.setPulsing(true))
    )
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

  frame = captureFrame(feed, CAPTURE_W, CAM_ROT)
  if (!frame) {
    shutter.disabled = false
    return
  }

  // Freeze the viewfinder while the photo is handed on; a live frame still moving under a
  // still picture reads as a fault.
  feed.pause()

  // Opens at the ends of the track; settleLevels() walks them in to the channel's own range,
  // which is the movement that says these handles can be moved.
  levels = CHANNELS.map(() => ({ black: 0, white: 255 }))
  thumbFrame = downscaleFrame(frame, 260)
  previewFrame = downscaleFrame(frame, 560)
  // The *camera's* dimensions, not the frame's: captureFrame has already applied the rotation
  // to the frame, and setAspect applies it again — feeding it the rotated size inverts the
  // aspect ratio for every screen after this one.
  setAspect(feed.videoWidth, feed.videoHeight)

  await wait(t(TIMELINE.freezeHold))
  goToStep('edit')
}

// ── 2 and 4. the editors ────────────────────────────────────────────────────

/**
 * Build one levels chart per channel into whichever step is asking.
 *
 * Both editing steps use the same three controls over the same three values, so they are the
 * same component built into a different mount — a visitor who adjusts red on step 2 and then
 * looks at step 4 sees their own red, because there is only ever one set of numbers.
 */
function buildChannelEditors(host, slot) {
  destroyEditors()
  host.querySelectorAll(slot).forEach((el) => el.replaceChildren())

  CHANNELS.forEach((channel, i) => {
    bigEditors.push(
      createLevels({
        mount: host.querySelector(`[data-ch="${i}"] ${slot}`),
        channelIndex: i,
        bins: frame.histograms[i],
        get: () => levels[i],
        set: (next) => (levels[i] = next),
        compact: true,
        onInput: onLevelsChanged,
      })
    )
  })
}

/** Each channel on its own, for the astrophotography step. */
function drawBands(only = -1) {
  if (!thumbFrame) return
  astroStrip.querySelectorAll('.band-img').forEach((canvas, i) => {
    if (only !== -1 && only !== i) return
    drawChannel(canvas, thumbFrame, i, levelsLut(levels[i].black, levels[i].white))
  })
}

/** The three together, which is the picture the visitor is actually making. */
function drawPreview() {
  if (previewFrame) drawComposite(previewCanvas, previewFrame, lutsNow())
}

// ── 3. share ────────────────────────────────────────────────────────────────

async function onSubmit() {
  if (step() !== 'share') return
  submitBtn.disabled = true

  publishToWall({
    image: compositeURL(frame, lutsNow()),
    levels: levels.map((l) => ({ ...l })),
  })

  $('shareHint').textContent = 'Shared. It is on the wall now.'
  pop($('shareHint'))
  await wait(t(TIMELINE.shareHold))
  goToStep('astro')
}

// ── reset ───────────────────────────────────────────────────────────────────

function reset() {
  cancelAll()

  frame = null
  levels = null
  thumbFrame = null
  previewFrame = null
  destroyEditors()
  channelsEl.querySelectorAll('.channel-editor').forEach((el) => el.replaceChildren())
  astroStrip.querySelectorAll('.band-editor').forEach((el) => el.replaceChildren())

  // Undo anything left on the elements that outlive a visitor.
  front = photoA
  feed.play().catch(() => {}) // takePhoto() paused it for the hand-off
  countdownEl.textContent = ''
  submitBtn.disabled = false
  ;[photoA, photoB, shareCanvas, previewCanvas, ...astroStrip.querySelectorAll('.band-img')].forEach(
    (c) => c.getContext('2d').clearRect(0, 0, c.width, c.height)
  )

  goToStep('camera', { animate: false })
  setAspect(feed.videoWidth, feed.videoHeight)
  shutter.disabled = !feed.videoWidth
}

// ── wiring ──────────────────────────────────────────────────────────────────

shutter.addEventListener('click', runCountdown)
nextBtn.addEventListener('click', nextStep)
submitBtn.addEventListener('click', onSubmit)
resetBtn.addEventListener('click', reset)

boot()
