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

import { startCamera } from './camera.js'
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

  beat1: 500, // "the camera captured light"
  beat2: 2600, // "that light was filtered into R G B"
  chipStagger: 260, // R, then G, then B lighting up
  editorIn: 900, // the levels editor arriving after beat 2

  channelSwap: 420, // between one channel's editor appearing and the Next button

  revealGrey: 700, // reveal: greyscale holds...
  revealOriginal: 1500, // ...crossfades to what the camera actually captured...
  revealUser: 2600, // ...then slowly to the visitor's version
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

let frame = null // { width, height, planes, luma, histograms } — written once, read-only after
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
    bigEditors.push(createLevels({ ...shared, mount: editorMount, onInput: onLevelsChanged }))
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
    box.textContent = `No camera: ${err.message}`
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
  setStage('intro') // CSS squishes the photo out of full-frame and into the bay
  $('photoTag').textContent = 'Your photo'

  await wait(t(TIMELINE.beat1))
  pop($('beat1'))

  await wait(t(TIMELINE.beat2))
  pop($('beat2'))
  // R, then G, then B light up as the sentence lands.
  document.querySelectorAll('#beat2 .chip').forEach((chip, i) => {
    later(t(TIMELINE.chipStagger * (i + 1)), () => chip.classList.add('lit'))
  })

  await wait(t(TIMELINE.editorIn))
  enterTune(0)
}

// ── 4–5. one channel at a time ──────────────────────────────────────────────

function enterTune(index) {
  setStage(TUNE_STAGES[index])
  const channel = CHANNELS[index]
  $('photoTag').textContent = `${channel.label} channel`

  // Only this channel's chip stays lit, so the highlight tracks the walkthrough.
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.classList.toggle('lit', chip.classList.contains(`chip-${channel.key.toLowerCase()}`))
  })

  paint((c) => drawChannel(c, frame, index, levelsLut(levels[index].black, levels[index].white)))
  pop(bigEditors[index].root)
  rise(nextBtn, TIMELINE.channelSwap)
}

function onNext() {
  const idx = TUNE_STAGES.indexOf(stage())
  if (idx === -1) return
  if (idx < TUNE_STAGES.length - 1) enterTune(idx + 1)
  else runReveal()
}

// ── 6–7. the reveal, then final touches ─────────────────────────────────────

async function runReveal() {
  setStage('reveal')
  document.querySelectorAll('.chip').forEach((chip) => chip.classList.add('lit'))

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
  await wait(t(TIMELINE.revealUser))

  setStage('finale')
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
  countdownEl.textContent = ''
  submitBtn.disabled = false
  document.querySelectorAll('.chip').forEach((chip) => chip.classList.remove('lit'))
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
