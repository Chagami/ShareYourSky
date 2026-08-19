// Image pipeline: one exposure -> three channel planes -> per-channel levels -> composite.
//
// The capture is split into its real red, green and blue planes once. Everything the visitor
// does afterwards is a per-channel levels curve (a black point and a white point) applied as a
// 256-entry lookup table. The planes are written once and only ever read, so the underlying
// measurement is never destroyed no matter how far the levels are pushed.

export const CHANNELS = [
  { key: 'R', label: 'Red', accent: '#ff5252', rgb: [255, 82, 82] },
  { key: 'G', label: 'Green', accent: '#3ddc6b', rgb: [61, 220, 107] },
  { key: 'B', label: 'Blue', accent: '#4d94ff', rgb: [77, 148, 255] },
]

// Rec. 709 luma, matching CSS `filter: grayscale()` so a CSS-desaturated preview and the
// greyscale we compute here are the same image.
const LUMA = [0.2126, 0.7152, 0.0722]

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v)

/**
 * Take the exposure: grab the frame mirrored, then split it into planes plus a luma plane.
 * Everything downstream needs is computed once, here.
 */
export function captureFrame(video, maxW = 900) {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null

  const scale = Math.min(1, maxW / vw)
  const width = Math.round(vw * scale)
  const height = Math.round(vh * scale)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.translate(width, 0)
  ctx.scale(-1, 1) // mirror, so the live feed reads like a mirror
  ctx.drawImage(video, 0, 0, width, height)
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  const data = ctx.getImageData(0, 0, width, height).data
  const n = width * height
  const planes = [new Uint8ClampedArray(n), new Uint8ClampedArray(n), new Uint8ClampedArray(n)]
  const luma = new Uint8ClampedArray(n)

  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    planes[0][p] = r
    planes[1][p] = g
    planes[2][p] = b
    luma[p] = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b
  }

  return { width, height, planes, luma, histograms: planes.map(histogram) }
}

/** How many pixels sit at each value — the shape the levels chart draws. */
export function histogram(plane) {
  const bins = new Uint32Array(256)
  for (let p = 0; p < plane.length; p++) bins[plane[p]]++
  return bins
}

/**
 * A levels curve as a lookup table: at or below `black` goes to 0, at or above `white` goes to
 * 255, and everything between is stretched linearly. The same operation as the black and white
 * point handles in any photo editor.
 */
export function levelsLut(black, white) {
  const lut = new Uint8ClampedArray(256)
  const lo = Math.max(0, Math.min(254, Math.round(black)))
  const hi = Math.max(lo + 1, Math.min(255, Math.round(white)))
  const span = hi - lo
  for (let v = 0; v < 256; v++) lut[v] = clamp255(((v - lo) / span) * 255)
  return lut
}

export const IDENTITY_LUT = levelsLut(0, 255)

function fit(canvas, frame) {
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width
    canvas.height = frame.height
  }
  return canvas.getContext('2d')
}

// One reusable ImageData per canvas, so dragging a handle doesn't allocate per frame.
const buffers = new WeakMap()

function bufferFor(canvas, ctx, w, h) {
  let buf = buffers.get(canvas)
  if (!buf || buf.width !== w || buf.height !== h) {
    buf = ctx.createImageData(w, h)
    buffers.set(canvas, buf)
  }
  return buf
}

/** All three planes through their own levels curve, recombined. */
export function drawComposite(canvas, frame, luts) {
  const ctx = fit(canvas, frame)
  const out = bufferFor(canvas, ctx, frame.width, frame.height)
  const d = out.data
  const [pr, pg, pb] = frame.planes
  const [lr, lg, lb] = luts

  for (let p = 0, i = 0; p < pr.length; p++, i += 4) {
    d[i] = lr[pr[p]]
    d[i + 1] = lg[pg[p]]
    d[i + 2] = lb[pb[p]]
    d[i + 3] = 255
  }
  ctx.putImageData(out, 0, 0)
}

/** One channel on its own, tinted — so adjusting red actually shows you red. */
export function drawChannel(canvas, frame, channelIndex, lut) {
  const ctx = fit(canvas, frame)
  const out = bufferFor(canvas, ctx, frame.width, frame.height)
  const d = out.data
  const plane = frame.planes[channelIndex]
  const [cr, cg, cb] = CHANNELS[channelIndex].rgb

  for (let p = 0, i = 0; p < plane.length; p++, i += 4) {
    const v = lut[plane[p]] / 255
    d[i] = clamp255(cr * v)
    d[i + 1] = clamp255(cg * v)
    d[i + 2] = clamp255(cb * v)
    d[i + 3] = 255
  }
  ctx.putImageData(out, 0, 0)
}

/** Brightness only — what the sensor measured before any colour was assigned. */
export function drawGrey(canvas, frame) {
  const ctx = fit(canvas, frame)
  const out = bufferFor(canvas, ctx, frame.width, frame.height)
  const d = out.data
  const { luma } = frame

  for (let p = 0, i = 0; p < luma.length; p++, i += 4) {
    d[i] = d[i + 1] = d[i + 2] = luma[p]
    d[i + 3] = 255
  }
  ctx.putImageData(out, 0, 0)
}

/** The finished image, for the gallery wall. */
export function compositeURL(frame, luts, quality = 0.88) {
  const canvas = document.createElement('canvas')
  drawComposite(canvas, frame, luts)
  return canvas.toDataURL('image/jpeg', quality)
}
