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
  const dpr = Math.min(2, window.devicePixelRatio || 1)
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

  // the levels ramp itself, drawn over the histogram
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)'
  ctx.lineWidth = 1.5 * dpr
  ctx.beginPath()
  ctx.moveTo(0, h)
  ctx.lineTo(x(black), h)
  ctx.lineTo(x(white), 0)
  ctx.lineTo(w, 0)
  ctx.stroke()
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
}) {
  const channel = CHANNELS[channelIndex]

  const root = document.createElement('div')
  root.className = 'levels' + (compact ? ' levels-compact' : '')
  root.style.setProperty('--acc', channel.accent)

  root.innerHTML = `
    <div class="levels-head">
      <span class="levels-name"><i class="levels-dot"></i>${channel.label}</span>
      <span class="levels-read"><b class="lv-black">0</b> — <b class="lv-white">255</b></span>
    </div>
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
  const readBlack = root.querySelector('.lv-black')
  const readWhite = root.querySelector('.lv-white')
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
    const { black, white } = get()
    handles.black.style.left = `${(black / 255) * 100}%`
    handles.white.style.left = `${(white / 255) * 100}%`
    handles.black.setAttribute('aria-valuenow', String(black))
    handles.white.setAttribute('aria-valuenow', String(white))
    readBlack.textContent = String(black)
    readWhite.textContent = String(white)
  }

  /** The expensive half: 256 bars and the ramp. Coalesced to one a frame by the owner. */
  function redraw() {
    if (!sized) return
    const { black, white } = get()
    drawHistogram(chart, bins, channel.accent, black, white)
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

  /** Keep at least one unit of range, so the levels curve can never divide by zero. */
  function commit(kind, value) {
    if (!touched) {
      touched = true
      root.classList.remove('pulsing')
      onFirstTouch?.()
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

  return { refresh, redraw, root, setPulsing, destroy }
}
