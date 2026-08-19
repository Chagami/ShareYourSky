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

import { startCamera, CameraSetupError } from './camera.js'
import {
  CHANNELS, captureFrame, levelsLut, IDENTITY_LUT,
  drawComposite, drawChannel, drawGrey, compositeURL,
} from './imaging.js'
import { createLevels } from './levels.js'
import { publish as publishToWall } from './store.js'

// ── the knobs you'll actually want to turn ──────────────────────────────────

const TIMELINE = {
  countdownFrom: 5,
  countdownTick: 900, // 5-4-3-2-1 at this cadence
  freezeHold: 420,

  photoSwell: 420, // the photo drifts right off the viewfinder and swells...
  photoSettle: 760, // ...then travels left and shrinks into the bay

  beat1: 500, // pause after the photo lands, before the sentence starts typing
  typeChar: 34, // per character
  typePunct: 240, // extra beat on a comma, so it reads like someone talking
  lightIn: 380, // "light" blooms onto its own row once the line finishes
  panelShift: 520, // text gliding to its new place when the editor changes the panel height
  beat2: 1300, // "that light was filtered into R G B" — timed from the light word
  chipStagger: 260, // R, then G, then B lighting up
  editorIn: 900, // the levels editor arriving after beat 2

  handlePulseAt: 260, // the handles start asking to be touched, once they have settled
  levelsSettleAt: 520, // the handles wait for the editor to land before they move...
  levelsSettle: 780, // ...then slide from the ends of the track to the channel's own range
  nextFallbackAt: 18000, // Next appears anyway after this long, so nobody is ever stranded

  revealGrey: 700, // reveal: greyscale holds...
  revealOriginal: 1500, // ...crossfades to what the camera actually captured...
  revealUser: 2600, // ...then slowly to the visitor's version
  beatOut: 520, // a sentence leaving, rather than being switched off
  finaleIn: 600,

  blowAway: 1500, // the wind-blown exit
  resetButtonAt: 3000, // "after 3 seconds, a reset button comes up"
  autoResetAt: 45000,
}

const CAPTURE_W = 900

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
const editorMount = $('editor')
const touchupMount = $('touchups')
const beat1Line = $('beat1Line')
const lightWord = $('lightWord')
const lightRays = $('lightRays')
const panel = document.querySelector('.panel')
const nextBtn = $('nextBtn')
const submitBtn = $('submitBtn')
const resetBtn = $('resetBtn')

const SECTION_FOR = {
  live: 'live', countdown: 'live',
  intro: 'work', tuneR: 'work', tuneG: 'work', tuneB: 'work', reveal: 'work', finale: 'work',
  thanks: 'thanks',
}
const TUNE_STAGES = ['tuneR', 'tuneG', 'tuneB']

let gen = 0
let anims = []
let timers = []

let frame = null // { width, height, planes, luma, histograms, rest } — written once, read-only after
let levels = null // [{black, white} x3] — the only thing the visitor changes
let bigEditors = []
let smallEditors = []
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

/**
 * Split a line into per-character spans once, so it can be typed out later. Words are kept
 * whole in an inline-block each and the spaces between them left as real text, which is what
 * lets the line wrap normally — a span per space would either collapse or refuse to break.
 */
function splitChars(el) {
  if (el.dataset.split) return [...el.querySelectorAll('.ch')]
  const words = el.textContent.trim().split(/\s+/)
  el.textContent = ''
  words.forEach((word, i) => {
    if (i) el.append(' ')
    const w = document.createElement('span')
    w.className = 'word'
    for (const ch of word) {
      const c = document.createElement('span')
      c.className = 'ch'
      c.textContent = ch
      w.append(c)
    }
    el.append(w)
  })
  el.dataset.split = '1'
  return [...el.querySelectorAll('.ch')]
}

/**
 * Type the line out. Every wait is generation-guarded, so a reset mid-sentence simply leaves
 * the loop hanging forever rather than racing the next visitor's turn.
 */
async function typeOut(el) {
  const chars = splitChars(el)
  chars.forEach((c) => c.classList.remove('on', 'at'))

  for (let i = 0; i < chars.length; i++) {
    chars[i - 1]?.classList.remove('at')
    chars[i].classList.add('on', 'at')
    const pause = /[,;:]/.test(chars[i].textContent) ? TIMELINE.typePunct : 0
    await wait(t(TIMELINE.typeChar + pause))
  }
  chars.at(-1)?.classList.remove('at')
}

/** "light" arrives as one word rather than typed: five characters at that size read as a
 *  banner, and the shafts need something to land on all at once. */
function revealLightWord() {
  return track(
    lightWord.animate(
      [
        { opacity: 0, transform: 'translateY(10px) scale(.94)', filter: 'blur(6px)' },
        { opacity: 1, transform: 'none', filter: 'blur(0)' },
      ],
      { duration: t(760), easing: EASE, fill: 'both' }
    )
  )
}

/**
 * Move the panel's text to its new resting place instead of letting it teleport there. The
 * workbench is vertically centred, so anything that changes the panel's height — the levels
 * editor arriving, the Next button appearing — shunts every line above it by half that height
 * in a single frame. Measure, mutate, then animate the difference away.
 */
function flipPanelText(mutate) {
  const kept = [...panel.children].filter((n) => n.getBoundingClientRect().height > 0)
  const before = kept.map((n) => n.getBoundingClientRect().top)
  mutate()
  kept.forEach((n, i) => {
    const dy = before[i] - n.getBoundingClientRect().top
    if (Math.abs(dy) < 1) return
    track(
      n.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
        duration: t(TIMELINE.panelShift),
        easing: EASE,
        fill: 'both',
      })
    )
  })
}

/**
 * Send a beat away instead of cutting it. Text that simply stops existing between one screen
 * and the next reads as a glitch; the same text drifting up and dissolving reads as the piece
 * moving on. Opacity only, so the line keeps its space and nothing below it jumps.
 *
 * Linear, deliberately. An eased fade holds the text near full opacity for most of its
 * duration and then dumps the rest in a few frames — measurably so: an ease-in curve here
 * stepped opacity by 0.13 in a single frame where linear steps by 0.026. That late dump is the
 * hang-then-cut this was meant to fix. Nobody reads a 520ms text fade as mechanical.
 */
function dismiss(nodes, stagger = 70) {
  const live = nodes.filter(Boolean)
  live.forEach((node, i) =>
    track(
      node.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-16px)' }], {
        duration: t(TIMELINE.beatOut),
        delay: t(i * stagger),
        easing: 'linear',
        fill: 'both',
      })
    )
  )
}

/**
 * Run the entrances for one beat. Elements marked [data-hold] are skipped: their reveal is
 * scheduled elsewhere, and sweeping them up here would fire it early and then leave two
 * competing animations on the same element.
 */
function revealAll(root) {
  if (!root) return
  root.querySelectorAll('.pop:not([data-hold]), .rise:not([data-hold])').forEach((node) => {
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

// ── the photo bay: two stacked canvases, so any change can crossfade ────────

const lutsNow = () => levels.map((l) => levelsLut(l.black, l.white))
const lutsIdentity = () => [IDENTITY_LUT, IDENTITY_LUT, IDENTITY_LUT]

/** Draw straight onto whichever canvas is showing — no transition. */
function paint(drawFn) {
  drawFn(front)
}

/**
 * Draw onto the hidden canvas, then crossfade it in. Used for the reveal sequence, where the
 * whole point is watching one version become another.
 */
function crossfadeTo(drawFn, duration) {
  const back = front === photoA ? photoB : photoA
  drawFn(back)
  track(back.animate([{ opacity: 0 }, { opacity: 1 }], { duration: t(duration), easing: 'ease-in-out', fill: 'both' }))
  track(front.animate([{ opacity: 1 }, { opacity: 0 }], { duration: t(duration), easing: 'ease-in-out', fill: 'both' }))
  front = back
}

/**
 * Carry the photo out of the viewfinder and into the bay instead of cutting between two
 * layouts. FLIP: the stack is already sitting in its final place, so measure both boxes,
 * start it transformed onto the live frame, and animate back to no transform at all.
 *
 * The midpoint is the whole point. A straight tween from big-and-centred to small-and-left
 * reads as the image collapsing; a drift to the right with a slight swell first reads as the
 * photo being lifted off the camera before it is set down on the bench. The same anticipation
 * beat the send-off uses, run in reverse.
 */
function morphPhotoIntoBay() {
  const from = feed.getBoundingClientRect()
  const to = photoStack.getBoundingClientRect()
  if (!from.width || !to.width) return null

  const scale = from.height / to.height
  const dx = from.left + from.width / 2 - (to.left + to.width / 2)
  const dy = from.top + from.height / 2 - (to.top + to.height / 2)

  // Lead right by a fraction of the journey rather than a fixed pixel count, so the swell
  // stays in proportion on a laptop and on the exhibit wall alike.
  const lead = Math.max(24, Math.abs(dx) * 0.18)
  const total = TIMELINE.photoSwell + TIMELINE.photoSettle

  return track(
    photoStack.animate(
      [
        {
          transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
          offset: 0,
          easing: 'cubic-bezier(.33,.85,.5,1)', // off the viewfinder, decisive
        },
        {
          transform: `translate(${dx + lead}px, ${dy}px) scale(${scale * 1.06})`,
          offset: TIMELINE.photoSwell / total,
          easing: 'cubic-bezier(.55,0,.25,1)', // the long travel: gentle away, gentle down
        },
        { transform: 'none', offset: 1 },
      ],
      { duration: t(total), fill: 'both' }
    )
  )
}

// ── the levels editors ──────────────────────────────────────────────────────

function buildEditors() {
  editorMount.replaceChildren()
  touchupMount.replaceChildren()
  bigEditors = []
  smallEditors = []

  CHANNELS.forEach((channel, i) => {
    const shared = {
      channelIndex: i,
      bins: frame.histograms[i],
      get: () => levels[i],
      set: (next) => (levels[i] = next),
    }
    // One large editor per channel, shown in turn during the walkthrough.
    bigEditors.push(
      createLevels({
        ...shared,
        mount: editorMount,
        onInput: onLevelsChanged,
        onFirstTouch: () => revealNext(i),
      })
    )
    // Three compact ones for final touches. Both sets read the same state, so they agree.
    smallEditors.push(createLevels({ ...shared, mount: touchupMount, compact: true, onInput: onLevelsChanged }))
  })
}

function refreshEditors() {
  bigEditors.forEach((e) => e.refresh())
  smallEditors.forEach((e) => e.refresh())
}

/** A handle moved: repaint whatever the current beat is showing. */
function onLevelsChanged() {
  refreshEditors()
  const s = stage()
  const idx = TUNE_STAGES.indexOf(s)
  if (idx >= 0) {
    // While tuning one channel, the photo shows that channel alone.
    paint((c) => drawChannel(c, frame, idx, levelsLut(levels[idx].black, levels[idx].white)))
  } else if (s === 'finale') {
    paint((c) => drawComposite(c, frame, lutsNow()))
  }
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

  const step = (now) => {
    if (g !== gen) return
    // Next was pressed mid-slide: land on the target rather than leaving it half moved.
    if (stage() !== TUNE_STAGES[index]) {
      levels[index] = { ...target }
      refreshEditors()
      return
    }
    const p = Math.min(1, (now - started) / duration)
    const e = 1 - (1 - p) ** 5 // an ease-out close enough to the house curve
    levels[index] = {
      black: Math.round(from.black + (target.black - from.black) * e),
      white: Math.round(from.white + (target.white - from.white) * e),
    }
    onLevelsChanged()
    if (p < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

// ── 1. live ─────────────────────────────────────────────────────────────────

async function boot() {
  setStage('live')

  try {
    await startCamera(feed, { want: new URLSearchParams(location.search).get('cam') })
    setAspect(feed.videoWidth, feed.videoHeight)
    feed.addEventListener('loadedmetadata', () => setAspect(feed.videoWidth, feed.videoHeight))
    shutter.disabled = false
  } catch (err) {
    shutter.disabled = true
    const box = $('camError')
    box.hidden = false
    box.textContent =
      err instanceof CameraSetupError ? err.message : `No camera: ${err.message}`
  }
}

// ── 2. countdown ────────────────────────────────────────────────────────────

async function runCountdown() {
  if (!feed.videoWidth || stage() !== 'live') return
  setStage('countdown')
  shutter.disabled = true

  for (let n = TIMELINE.countdownFrom; n >= 1; n--) {
    countdownEl.textContent = String(n)
    track(
      countdownEl.animate(
        [
          { opacity: 0, transform: 'scale(1.6)' },
          { opacity: 1, transform: 'scale(1)', offset: 0.35 },
          { opacity: 0, transform: 'scale(.85)' },
        ],
        { duration: t(TIMELINE.countdownTick), easing: 'ease-out', fill: 'both' }
      )
    )
    await wait(t(TIMELINE.countdownTick))
  }
  countdownEl.textContent = ''
  takePhoto()
}

async function takePhoto() {
  flash.classList.remove('go')
  void flash.offsetWidth
  flash.classList.add('go')

  frame = captureFrame(feed, CAPTURE_W)
  if (!frame) {
    setStage('live')
    shutter.disabled = false
    return
  }

  // Freeze the viewfinder. The photo is about to slide out of it, and a live frame still
  // moving underneath during that flight reads as a double exposure.
  feed.pause()

  levels = CHANNELS.map(() => ({ black: 0, white: 255 }))
  setAspect(frame.width, frame.height)
  buildEditors()

  // The photo appears exactly as taken.
  paint((c) => drawComposite(c, frame, lutsIdentity()))
  await wait(t(TIMELINE.freezeHold))
  runIntro()
}

// ── 3–4. the didactic beats ─────────────────────────────────────────────────

async function runIntro() {
  setStage('intro')
  $('photoTag').textContent = 'Your photo'
  morphPhotoIntoBay()

  // The caption belongs to the bay, so hold it back until the photo is nearly home — otherwise
  // it sits under an empty space for the whole flight.
  track(
    $('photoTag').animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: t(300),
      delay: t(TIMELINE.photoSwell + TIMELINE.photoSettle * 0.55),
      fill: 'both',
    })
  )

  // beat1 is timed from the end of the swell, not from the cut: a sentence arriving while the
  // photo is still in the air competes with the movement for the same attention.
  await wait(t(TIMELINE.photoSwell + TIMELINE.beat1))
  pop($('beat1'))
  await typeOut(beat1Line)

  await wait(t(TIMELINE.lightIn))
  revealLightWord()

  await wait(t(TIMELINE.beat2))
  pop($('beat2'))
  // The sentence says the light was split, so the shafts split with it: the white beam
  // becomes a dull rainbow. No band is picked out yet — that starts with the first channel.
  lightRays.classList.add('rainbow')
  // R, then G, then B light up as the sentence lands.
  document.querySelectorAll('#beat2 .chip').forEach((chip, i) => {
    later(t(TIMELINE.chipStagger * (i + 1)), () => chip.classList.add('lit'))
  })

  await wait(t(TIMELINE.editorIn))
  enterTune(0)
}

// ── 4–5. one channel at a time ──────────────────────────────────────────────

function enterTune(index) {
  // The editor arriving changes the panel's height, which would otherwise jerk every line of
  // text above it upward in one frame.
  flipPanelText(() => setStage(TUNE_STAGES[index]))
  const channel = CHANNELS[index]

  // The same band of the rainbow the chip is lighting.
  lightRays.dataset.band = channel.key.toLowerCase()
  $('photoTag').textContent = `${channel.label} channel`

  // Only this channel's chip stays lit, so the highlight tracks the walkthrough.
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.classList.toggle('lit', chip.classList.contains(`chip-${channel.key.toLowerCase()}`))
  })

  paint((c) => drawChannel(c, frame, index, levelsLut(levels[index].black, levels[index].white)))
  pop(bigEditors[index].root)

  // Next is earned rather than given: it stays hidden until a handle has actually moved. The
  // previous channel's reveal has to be cancelled explicitly — rise() fills forwards, so its
  // opacity would otherwise carry over and leave the button visible on this channel too.
  nextBtn.getAnimations().forEach((a) => a.cancel())
  nextBtn.disabled = true
  later(t(TIMELINE.nextFallbackAt), () => revealNext(index))

  // After the editor has arrived, not during: handles moving while the panel is still
  // animating in is movement nobody is looking at yet.
  later(t(TIMELINE.levelsSettleAt), () => {
    settleLevels(index)
    later(t(TIMELINE.levelsSettle + TIMELINE.handlePulseAt), () =>
      bigEditors[index].setPulsing(true)
    )
  })
}

/**
 * Bring Next up. Fired by the first handle movement, and again on a fallback timer.
 *
 * The timer is the important half. Gating the only way forward on a gesture the visitor has to
 * discover is exactly the kind of thing that strands somebody at an unattended exhibit, and a
 * screen with no visible way out is a floor-staff problem rather than a design one.
 */
function revealNext(index) {
  if (stage() !== TUNE_STAGES[index] || !nextBtn.disabled) return
  nextBtn.disabled = false
  rise(nextBtn)
}

function onNext() {
  const idx = TUNE_STAGES.indexOf(stage())
  if (idx === -1) return
  if (idx < TUNE_STAGES.length - 1) enterTune(idx + 1)
  else runReveal()
}

// ── 6–7. the reveal, then final touches ─────────────────────────────────────

async function runReveal() {
  flipPanelText(() => setStage('reveal'))
  document.querySelectorAll('.chip').forEach((chip) => chip.classList.add('lit'))
  // The whole spectrum lights as the first sentence lifts away — the split light going back
  // together, which is exactly what the photo is about to do.
  lightRays.dataset.band = 'all'
  dismiss([$('beat1')])

  // Brightness only — what the sensor actually measured.
  $('photoTag').textContent = 'Brightness only'
  crossfadeTo((c) => drawGrey(c, frame), 700)
  await wait(t(TIMELINE.revealGrey))

  // What the camera handed over, untouched.
  $('photoTag').textContent = 'As the camera captured it'
  crossfadeTo((c) => drawComposite(c, frame, lutsIdentity()), 900)
  await wait(t(TIMELINE.revealOriginal))

  // And slowly into the visitor's version.
  $('photoTag').textContent = 'Your version'
  crossfadeTo((c) => drawComposite(c, frame, lutsNow()), TIMELINE.revealUser)

  // Clear the second sentence *during* the last crossfade rather than on the way into the
  // finale. It has done its work by now, and holding it until the stage change meant it sat
  // there through the whole reveal and then vanished in one frame. Dismissing it here costs
  // no extra time — the panel is simply already empty when the essay arrives.
  later(t(TIMELINE.revealUser * 0.55), () => dismiss([$('beat2')]))
  await wait(t(TIMELINE.revealUser))

  flipPanelText(() => setStage('finale'))
  refreshEditors()
  revealAll($('finale'))
  rise(submitBtn, TIMELINE.finaleIn)
}

// ── 8. send-off ─────────────────────────────────────────────────────────────

async function onSubmit() {
  if (stage() !== 'finale') return
  submitBtn.disabled = true

  publishToWall({
    image: compositeURL(frame, lutsNow()),
    levels: levels.map((l) => ({ ...l })),
  })

  // Blow the photo off to a random edge, as if caught by wind.
  const edge = Math.floor(Math.random() * 4)
  const dist = 120
  const [dx, dy] = [[0, -dist], [dist, 0], [0, dist], [-dist, 0]][edge]
  const spin = (Math.random() > 0.5 ? 1 : -1) * (420 + Math.random() * 260)

  track(
    photoStack.animate(
      [
        { transform: 'translate(0, 0) rotate(0deg) scale(1)', opacity: 1 },
        {
          transform: `translate(${dx * 0.25}vw, ${dy * 0.25}vh) rotate(${spin * 0.2}deg) scale(1.04)`,
          opacity: 1,
          offset: 0.25,
        },
        { transform: `translate(${dx}vw, ${dy}vh) rotate(${spin}deg) scale(.35)`, opacity: 0 },
      ],
      { duration: t(TIMELINE.blowAway), easing: 'cubic-bezier(.3,.1,.6,1)', fill: 'both' }
    )
  )

  await wait(t(TIMELINE.blowAway * 0.7))
  setStage('thanks')
  revealAll(document.querySelector('.stage-thanks'))

  later(t(TIMELINE.resetButtonAt), () => rise(resetBtn))
  later(t(TIMELINE.autoResetAt), reset)
}

// ── reset ───────────────────────────────────────────────────────────────────

function reset() {
  cancelAll()

  frame = null
  levels = null
  bigEditors = []
  smallEditors = []
  editorMount.replaceChildren()
  touchupMount.replaceChildren()

  // Undo anything the animations left behind on the persistent elements.
  front = photoA
  nextBtn.disabled = true
  feed.play().catch(() => {}) // takePhoto() paused it for the hand-off
  countdownEl.textContent = ''
  submitBtn.disabled = false
  document.querySelectorAll('.chip').forEach((chip) => chip.classList.remove('lit'))
  beat1Line.querySelectorAll('.ch').forEach((c) => c.classList.remove('on', 'at'))
  lightRays.classList.remove('rainbow')
  delete lightRays.dataset.band
  ;[photoA, photoB].forEach((c) => c.getContext('2d').clearRect(0, 0, c.width, c.height))

  setStage('live')
  setAspect(feed.videoWidth, feed.videoHeight)
  shutter.disabled = !feed.videoWidth
}

// ── wiring ──────────────────────────────────────────────────────────────────

shutter.addEventListener('click', runCountdown)
nextBtn.addEventListener('click', onNext)
submitBtn.addEventListener('click', onSubmit)
resetBtn.addEventListener('click', reset)

boot()
