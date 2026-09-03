// The levels editor: a histogram with the black-point and white-point handles built into it.
//
// Used at two sizes — one large editor per channel during the guided walkthrough, and three
// compact ones for final touches. Every instance reads and writes the same shared levels state
// passed in as get/set, so the big and small editors can never disagree.
//
// The handles are custom elements rather than range inputs: two overlaid full-width ranges
// fight for the same pointer when the values get close. These are real focusable widgets with
// arrow-key support, so they stay keyboard- and test-drivable.

import { CHANNELS } from './imaging.js'

const HANDLES = [
  { kind: 'black', label: 'Black point' },
  { kind: 'white', label: 'White point' },
]

/**
 * Draw the histogram, shading the ranges the current levels are throwing away. The clipped
 * shoulders are the whole point: the visitor should see what they are discarding.
 */
export function drawHistogram(canvas, bins, accent, black, white) {
  // The backing store is sized by the ResizeObserver in createLevels, not here. Reading
  // clientWidth on every draw forced a synchronous layout six times per pointer move — and on
  // a display:none editor it reads 0, so the canvas was being reallocated to 1px and redrawn
  // into, every move, for nothing.
  const w = canvas.width
  const h = canvas.height
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, w, h)

  // Log scale: a photo's histogram is dominated by a few huge bins, and a linear plot flattens
  // everything else into an unreadable line along the axis.
  let peak = 0
  for (let v = 0; v < 256; v++) peak = Math.max(peak, bins[v])
  const scale = peak > 0 ? h / Math.log1p(peak) : 0

  const x = (v) => (v / 255) * w

  // clipped regions
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)'
  ctx.fillRect(0, 0, x(black), h)
  ctx.fillRect(x(white), 0, w - x(white), h)

  // the histogram itself
  ctx.fillStyle = accent
  ctx.globalAlpha = 0.85
  const barW = Math.max(1, w / 256)
  for (let v = 0; v < 256; v++) {
    const bar = Math.log1p(bins[v]) * scale
    if (bar <= 0) continue
    ctx.globalAlpha = v < black || v > white ? 0.22 : 0.85
    ctx.fillRect(x(v), h - bar, barW, bar)
  }
  ctx.globalAlpha = 1
}

/**
 * Build one editor into `mount`.
 * `get()` returns { black, white } for this channel; `set(next)` writes it back.
 * Returns { refresh } so the owner can redraw after changing state elsewhere.
 */
export function createLevels({
  mount,
  channelIndex,
  bins,
  get,
  set,
  compact = false,
  onInput,
  onFirstTouch,
  // Optional, and only step 3 passes it. With it the chart grows a spectrum across its top and
  // is drawn in whatever colour this light has been given; without it a chart is simply its own
  // colour. The head keeps naming the *source* either way — which filter's light this is does
  // not change, only what colour it is being shown in.
  //   { get: () => degrees, set: (degrees) => void }
  hue = null,
}) {
  const channel = CHANNELS[channelIndex]
  /** The colour this chart is wearing: its own, unless something else is choosing. */
  const shownColor = () => (hue ? `hsl(${hue.get()}, 100%, 50%)` : channel.accent)

  const root = document.createElement('div')
  root.className = 'levels' + (compact ? ' levels-compact' : '')
  root.style.setProperty('--src', channel.accent) // the light itself — never changes
  root.style.setProperty('--acc', shownColor()) // the colour it is being shown in

  root.innerHTML = `
    <div class="levels-head">
      <span class="levels-name"><i class="levels-dot"></i>${channel.label}</span>
    </div>
    ${
      hue
        ? `<div class="spectrum">
             <div class="spectrum-bar"></div>
             <i class="spectrum-home" style="left:${(channel.hue / 360) * 100}%"
                title="${channel.label} light's own colour"></i>
             <button class="spectrum-pick" role="slider" aria-valuemin="0" aria-valuemax="360"
               aria-label="Colour to show ${channel.label} light as"></button>
           </div>`
        : ''
    }
    <div class="levels-plot">
      <canvas class="levels-chart" width="${compact ? 280 : 520}" height="${compact ? 60 : 150}"></canvas>
      <div class="levels-track">
        ${HANDLES.map(
          (hd) => `<button class="levels-handle handle-${hd.kind}" data-kind="${hd.kind}"
                     role="slider" aria-label="${channel.label} ${hd.label}"
                     aria-valuemin="0" aria-valuemax="255" aria-valuenow="0"></button>`
        ).join('')}
      </div>
    </div>`

  mount.append(root)

  const chart = root.querySelector('.levels-chart')
  const plot = root.querySelector('.levels-plot')
  const track = root.querySelector('.levels-track')
  const spectrum = root.querySelector('.spectrum')
  const spectrumBar = root.querySelector('.spectrum-bar')
  const spectrumPick = root.querySelector('.spectrum-pick')
  const handles = {
    black: root.querySelector('.handle-black'),
    white: root.querySelector('.handle-white'),
  }

  // Match the backing store to the on-screen size, but off the layout pass rather than by
  // asking for it. The chart is laid out width:100% with a fixed aspect-ratio, so it is
  // routinely displayed far wider than its authored size and would otherwise be a blurry
  // upscale; this keeps that true without a forced reflow on the hot path.
  let sized = false
  const observer = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect
    if (!box || !box.width) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = Math.max(1, Math.round(box.width * dpr))
    const h = Math.max(1, Math.round(box.height * dpr))
    if (chart.width === w && chart.height === h) return
    chart.width = w
    chart.height = h
    sized = true
    redraw()
  })
  observer.observe(chart)

  /**
   * The cheap half: where the handles sit and what the numbers say. This is what runs on the
   * handle you are actually dragging, so it tracks your finger without waiting for a frame.
   */
  function refresh() {
    if (hue) {
      const deg = hue.get()
      root.style.setProperty('--acc', shownColor())
      spectrumPick.style.left = `${(deg / 360) * 100}%`
      spectrumPick.setAttribute('aria-valuenow', String(Math.round(deg)))
    }

    const { black, white } = get()
    handles.black.style.left = `${(black / 255) * 100}%`
    handles.white.style.left = `${(white / 255) * 100}%`
    handles.black.setAttribute('aria-valuenow', String(black))
    handles.white.setAttribute('aria-valuenow', String(white))
  }

  /** The expensive half: 256 bars and the ramp. Coalesced to one a frame by the owner. */
  function redraw() {
    if (!sized) return
    const { black, white } = get()
    drawHistogram(chart, bins, shownColor(), black, white)
    refresh()
  }

  // Whether this instance has ever been moved by the visitor. Only real input reaches commit()
  // — the opening slide writes the levels directly — so this is a true first-touch flag.
  let touched = false

  /** Start or stop the pulse. A no-op once the visitor has found the handles. */
  function setPulsing(on) {
    if (touched) return
    root.classList.toggle('pulsing', on)
  }

  /**
   * Ask for the spectrum to be noticed.
   *
   * Separate from the handle pulse, and never both at once: on step 3 the handles have already
   * been used and the spectrum is the new thing, so two things asking for a finger at the same
   * time would only split the attention of someone who has one question to answer.
   */
  function setAsking(on) {
    spectrum?.classList.toggle('asking', on)
  }

  /** Keep at least one unit of range, so the levels curve can never divide by zero. */
  function commit(kind, value) {
    if (!touched) {
      touched = true
      root.classList.remove('pulsing')
      onFirstTouch?.(channelIndex)
    }
    const cur = get()
    const v = Math.max(0, Math.min(255, Math.round(value)))
    const next =
      kind === 'black'
        ? { black: Math.min(v, cur.white - 1), white: cur.white }
        : { black: cur.black, white: Math.max(v, cur.black + 1) }
    set(next)
    refresh()
    onInput?.(channelIndex)
  }

  const valueAt = (clientX) => {
    const r = track.getBoundingClientRect()
    return ((clientX - r.left) / r.width) * 255
  }

  let dragging = null

  const nearest = (v) => {
    const cur = get()
    return Math.abs(v - cur.black) <= Math.abs(v - cur.white) ? 'black' : 'white'
  }

  /**
   * The whole plot is the drag surface, not just the handles.
   *
   * Two things were losing touches. The handle is a 52px target on a chart nearly five times
   * that wide, so a finger that starts a few pixels off it started nothing at all. And the
   * pointer was captured on the handle, so a drag that began anywhere else was never captured
   * and every move outside went somewhere else. Pressing anywhere on the chart now grabs the
   * nearer handle and keeps it until the finger lifts.
   */
  function onDown(e) {
    const v = valueAt(e.clientX)
    const onHandle = e.target?.dataset?.kind
    dragging = onHandle ?? nearest(v)
    // Grab a handle where it already is; jump to the touch anywhere else.
    if (!onHandle) commit(dragging, v)
    plot.setPointerCapture?.(e.pointerId)
    e.preventDefault()
  }
  function onMove(e) {
    if (!dragging) return
    commit(dragging, valueAt(e.clientX))
  }
  function onUp() {
    dragging = null
  }

  /**
   * Give this light a different colour.
   *
   * The whole strip is the drag surface for the same reason the whole chart is: a 40px handle
   * on a strip five times that wide means a finger that lands a little wide of it starts
   * nothing at all. Measured against the bar rather than the strip, so the ends of the gradient
   * are 0 and 360 exactly.
   */
  function hueAt(clientX) {
    const r = spectrumBar.getBoundingClientRect()
    // A strip with no width divides by zero and hands back NaN, and a NaN hue is not a wrong
    // colour — it is no colour at all: it poisons the tint, the tint poisons the composite, and
    // every picture from then on is a blank canvas and a thrown error. Happens whenever the
    // strip is measured while its column is display:none, which is most of the piece.
    if (!r.width) return hue.get()
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * 360
  }

  function commitHue(deg) {
    if (!Number.isFinite(deg)) return
    hue.set(Math.round(deg))
    refresh()
    onInput?.(channelIndex)
  }

  if (spectrum) {
    let picking = false
    spectrum.addEventListener('pointerdown', (e) => {
      picking = true
      // Commit before capturing, and never let the capture take the tap down with it.
      // setPointerCapture throws if the pointer is already gone by the time the handler runs,
      // and with the order the other way round that turns a tap into nothing at all.
      commitHue(hueAt(e.clientX))
      try {
        spectrum.setPointerCapture?.(e.pointerId)
      } catch {
        /* the drag still works, it just will not follow a finger off the strip */
      }
      e.preventDefault()
    })
    spectrum.addEventListener('pointermove', (e) => picking && commitHue(hueAt(e.clientX)))
    const release = () => (picking = false)
    spectrum.addEventListener('pointerup', release)
    spectrum.addEventListener('pointercancel', release)

    spectrumPick.addEventListener('keydown', (e) => {
      const by = e.shiftKey ? 30 : 5
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') commitHue((hue.get() - by + 360) % 360)
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') commitHue((hue.get() + by) % 360)
      else return
      e.preventDefault()
    })
  }

  plot.addEventListener('pointerdown', onDown)
  plot.addEventListener('pointermove', onMove)
  plot.addEventListener('pointerup', onUp)
  plot.addEventListener('pointercancel', onUp)

  Object.values(handles).forEach((h) => {
    h.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 1
      const kind = h.dataset.kind
      const cur = get()[kind]
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') commit(kind, cur - step)
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') commit(kind, cur + step)
      else return
      e.preventDefault()
    })
  })

  refresh()

  /**
   * Let go of the observer.
   *
   * Editors are rebuilt on every capture, so without this each visitor leaves six live
   * ResizeObservers behind holding on to canvases that are no longer in the document. On a
   * desk that is invisible; on a memory-constrained kiosk running all day it is a leak with a
   * few hundred visitors in it.
   */
  function destroy() {
    observer.disconnect()
    root.remove()
  }

  return { refresh, redraw, root, setPulsing, setAsking, destroy }
}
