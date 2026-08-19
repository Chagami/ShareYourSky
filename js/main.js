// Is It Real? — stage machine and choreography.
//
//   live  ── shutter ─▶  ask  ── button ─▶  process  ── publish ─▶  final  ── 30s ─▶ live
//
// The whole flow is one long timed sequence, so every wait and every animation is tagged
// with a generation number. restart() bumps the generation, which cancels in-flight
// animations and makes any pending wait simply never resolve — no half-finished stage can
// bleed into the next visitor's turn.

import { startCamera } from './camera.js'
import { CHANNELS, captureFrame, channelLayers, drawChannel, drawComposite, compositeURL } from './imaging.js'
import { publish as publishToWall } from './store.js'

const EASE = 'cubic-bezier(.16, 1, .3, 1)'
const WORK_W = 420 // preview resolution while the sliders are live
const FULL_W = 960 // capture + published resolution
const RESTART_BUTTON_AT = 5000
const AUTO_RESTART_AT = 30000

// Honour the OS reduced-motion setting by compressing the whole sequence.
const PACE = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.25 : 1
const t = (ms) => Math.round(ms * PACE)

const $ = (id) => document.getElementById(id)
const feed = $('feed')
const shot = $('shot')
const shutter = $('shutter')
const flash = $('flash')
const beams = $('beams')
const channelsEl = $('channels')
const compositeCanvas = $('compositeCanvas')
const publishBtn = $('publish')
const restartBtn = $('restart')
const greyCaption = $('greyCaption')
const mixCaption = $('mixCaption')
const resultPanel = $('resultPanel')

let gen = 0
let anims = []
let timers = []

let capture = null // { canvas, colorURL, width, height }
let workLayers = null // the three measured channel planes, at preview resolution
let weights = [1, 1, 1]
const cards = [] // { root, canvas, slider, val }

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

/** Scale-and-settle entrance, preserving any per-element `--rot` tilt. */
function pop(node, delay = 0) {
  const rot = getComputedStyle(node).getPropertyValue('--rot').trim() || '0deg'
  return track(
    node.animate(
      [
        { opacity: 0, transform: `translateY(20px) scale(.86) rotate(${rot})`, offset: 0 },
        { opacity: 1, transform: `translateY(0) scale(1.035) rotate(${rot})`, offset: 0.62 },
        { opacity: 1, transform: `translateY(0) scale(1) rotate(${rot})`, offset: 1 },
      ],
      { duration: t(640), delay: t(delay), easing: EASE, fill: 'both' }
    )
  )
}

/** Slide-up entrance, used for the buttons that advance a stage. */
function rise(node, delay = 0) {
  return track(
    node.animate([{ opacity: 0, transform: 'translateY(46px)' }, { opacity: 1, transform: 'none' }], {
      duration: t(700),
      delay: t(delay),
      easing: EASE,
      fill: 'both',
    })
  )
}

// Created after the entrance, so it wins the animation cascade and fades from 1 to 0.
function fadeOut(node, delay = 0) {
  return track(
    node.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: t(420),
      delay: t(delay),
      easing: 'ease',
      fill: 'forwards',
    })
  )
}

function setStage(name) {
  document.querySelectorAll('.stage').forEach((s) => s.classList.toggle('active', s.dataset.for === name))
  document.body.dataset.stage = name
}

/** Keep the photo box matched to whatever the camera actually gives us. */
function setAspect(w, h) {
  if (w && h) document.documentElement.style.setProperty('--shot-ar', (w / h).toFixed(4))
}

// ── channel cards ───────────────────────────────────────────────────────────

function buildChannels() {
  CHANNELS.forEach((ch, i) => {
    const root = document.createElement('div')
    root.className = 'channel'
    root.style.setProperty('--acc', ch.accent)
    root.innerHTML = `
      <div class="channel-head"><span class="swatch"></span>${ch.label}<span class="val">100%</span></div>
      <canvas></canvas>
      <input class="slider" type="range" min="0" max="2" step="0.01" value="1" disabled
             aria-label="${ch.label} channel intensity">`
    channelsEl.appendChild(root)

    const card = {
      root,
      canvas: root.querySelector('canvas'),
      slider: root.querySelector('.slider'),
      val: root.querySelector('.val'),
    }
    card.slider.addEventListener('input', () => onSlide(i, parseFloat(card.slider.value)))
    cards.push(card)
    paintFill(card.slider)
  })
}

function paintFill(slider) {
  slider.style.setProperty('--fill', `${(slider.value / slider.max) * 100}%`)
}

let redrawQueued = false

function onSlide(index, value) {
  weights[index] = value
  cards[index].val.textContent = `${Math.round(value * 100)}%`
  paintFill(cards[index].slider)

  // Redraw all four canvases on the next frame: cheap at this working size, and it can't
  // drop an update the way a per-channel queue can when two sliders move together.
  if (redrawQueued) return
  redrawQueued = true
  requestAnimationFrame(() => {
    redrawQueued = false
    if (workLayers) redrawPreviews()
  })
}

function redrawPreviews() {
  cards.forEach((c, i) => drawChannel(c.canvas, workLayers, i, weights[i]))
  drawComposite(compositeCanvas, workLayers, weights)
}

function setSlidersEnabled(on) {
  cards.forEach((c) => (c.slider.disabled = !on))
}

// ── 1. live ─────────────────────────────────────────────────────────────────

async function boot() {
  buildChannels()
  setStage('live')

  const want = new URLSearchParams(location.search).get('cam')
  try {
    await startCamera(feed, { want })
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

async function onShutter() {
  if (!feed.videoWidth) return
  shutter.disabled = true

  flash.classList.remove('go')
  void flash.offsetWidth // restart the flash animation
  flash.classList.add('go')

  capture = captureFrame(feed, FULL_W)
  if (!capture) {
    shutter.disabled = false
    return
  }

  setAspect(capture.width, capture.height)
  shot.src = capture.colorURL
  shot.hidden = false
  shot.className = 'shot at-frame' // lands exactly where the live feed was

  await wait(t(140))
  runAsk()
}

// ── 2. is it real? ──────────────────────────────────────────────────────────

async function runAsk() {
  setStage('ask')
  await wait(t(80))

  shot.classList.remove('at-frame')
  shot.classList.add('at-aside') // slides out of the centre, making room for the questions

  await wait(t(400))
  document.querySelectorAll('.stage-ask [data-d]').forEach((node) => {
    const delay = Number(node.dataset.d) || 0
    ;(node.classList.contains('rise') ? rise : pop)(node, delay)
  })
}

// ── 3. processing ───────────────────────────────────────────────────────────

async function runProcess() {
  setStage('process') // the ask stage fades out on its own — that's the wipe
  shot.classList.remove('at-aside')
  shot.classList.add('at-top', 'bw') // kicked to the top, desaturating as it goes

  // Split the colour capture into its three measured planes while the CSS desaturation of
  // the photo plays, so the channel cards already hold real data when they're pulled out.
  workLayers = channelLayers(capture.canvas, WORK_W)
  redrawPreviews()

  await wait(t(750))
  pop(greyCaption)

  await wait(t(2500))
  fadeOut(greyCaption)
  await pullChannels()

  pop(mixCaption, 100)
  pop(resultPanel, 240)
  rise(publishBtn, 500)
  setSlidersEnabled(true)
  publishBtn.disabled = false
}

/**
 * The three channel cards start life mapped exactly onto the black-and-white photo and
 * then travel out to their own slots, gaining their colour on the way — so they read as
 * having been pulled out of that one greyscale frame. A beam trails behind each one.
 */
async function pullChannels() {
  const from = shot.getBoundingClientRect()
  drawBeams(from)

  const stagger = 200
  cards.forEach((card, i) => {
    const r = card.root.getBoundingClientRect()
    const scale = Math.max(0.1, Math.min(from.width / r.width, from.height / r.height))
    const dx = from.left + from.width / 2 - (r.left + r.width / 2)
    const dy = from.top + from.height / 2 - (r.top + r.height / 2)

    track(
      card.root.animate(
        [
          { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(${scale})`, offset: 0 },
          { opacity: 1, offset: 0.35 },
          { opacity: 1, transform: 'none', offset: 1 },
        ],
        { duration: t(1000), delay: t(220 + i * stagger), easing: EASE, fill: 'both' }
      )
    )
    later(t(420 + i * stagger), () => card.root.classList.add('tinted'))
  })

  await wait(t(220 + 2 * stagger + 1000))
}

function drawBeams(from) {
  beams.replaceChildren()
  const x0 = from.left + from.width / 2
  const y0 = from.bottom - 4

  cards.forEach((card, i) => {
    const r = card.root.getBoundingClientRect()
    const dx = r.left + r.width / 2 - x0
    const dy = Math.max(1, r.top + 8 - y0)
    const length = Math.hypot(dx, dy)
    // The beam hangs straight down from its top edge, so rotate it onto the card.
    const rot = -Math.atan2(dx, dy) * (180 / Math.PI)

    const beam = document.createElement('div')
    beam.className = 'beam'
    beam.style.left = `${x0}px`
    beam.style.top = `${y0}px`
    beam.style.height = `${length}px`
    beam.style.color = CHANNELS[i].accent
    beams.appendChild(beam)

    track(
      beam.animate(
        [
          { opacity: 0, transform: `rotate(${rot}deg) scaleY(0)`, offset: 0 },
          { opacity: 0.9, offset: 0.35 },
          { opacity: 0, transform: `rotate(${rot}deg) scaleY(1)`, offset: 1 },
        ],
        { duration: t(900), delay: t(120 + i * 200), easing: EASE, fill: 'both' }
      )
    )
  })
}

// ── 4. is this photo real? ──────────────────────────────────────────────────

function onPublish() {
  publishBtn.disabled = true
  setSlidersEnabled(false)

  const fullLayers = channelLayers(capture.canvas, FULL_W)
  const image = compositeURL(fullLayers, weights)
  publishToWall({ image, weights: weights.slice() })
  runFinal(image)
}

async function runFinal(image) {
  shot.classList.add('fade')
  setStage('final')

  later(t(RESTART_BUTTON_AT), () => rise(restartBtn))
  later(t(AUTO_RESTART_AT), restart)

  await wait(t(440))
  shot.src = image // the edited composite takes the original photo's place
  shot.classList.remove('bw', 'at-top')
  shot.classList.add('at-result')

  await wait(t(120))
  shot.classList.remove('fade')

  await wait(t(420))
  $('finalWeights').textContent = CHANNELS.map((c, i) => `${c.key} ${Math.round(weights[i] * 100)}%`).join('  ·  ')
  pop($('finalTitle'))
  pop($('finalNote'), 420)
  pop($('finalSent'), 760)
}

// ── restart ─────────────────────────────────────────────────────────────────

function restart() {
  cancelAll() // stops every pending wait and reverts every revealed element

  weights = [1, 1, 1]
  workLayers = null
  capture = null
  cards.forEach((card) => {
    card.slider.value = 1
    card.slider.disabled = true
    card.val.textContent = '100%'
    card.root.classList.remove('tinted')
    paintFill(card.slider)
  })
  beams.replaceChildren()
  publishBtn.disabled = true

  shot.classList.add('fade')
  setStage('live')
  setAspect(feed.videoWidth, feed.videoHeight)

  later(t(520), () => {
    shot.hidden = true
    shot.className = 'shot'
    shot.removeAttribute('src')
    shutter.disabled = !feed.videoWidth
  })
}

// ── wiring ──────────────────────────────────────────────────────────────────

shutter.addEventListener('click', onShutter)
$('toProcess').addEventListener('click', runProcess)
publishBtn.addEventListener('click', onPublish)
restartBtn.addEventListener('click', restart)

// Beam geometry is measured in pixels, so a resize (display swap, projector) invalidates
// it. They are a one-shot trail that has already played by then — just clear them.
addEventListener('resize', () => beams.replaceChildren())

boot()
