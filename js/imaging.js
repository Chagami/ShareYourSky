// Image pipeline: one exposure -> one intensity layer -> a colormap on top of it.
//
// The camera frame is reduced immediately to a single brightness value per pixel and that
// array is never modified again. Everything the visitor does afterwards is a lookup table on
// top of it. That is the physics the interaction is trying to be: acquisition produces an
// intensity map, processing chooses how to show it.

// Rec. 709 luma — the same coefficients CSS `filter: grayscale()` uses, so the live
// black-and-white preview and the intensity we compute from the frozen frame are the same
// image. The handoff from video to still is invisible.
const LUMA_R = 0.2126
const LUMA_G = 0.7152
const LUMA_B = 0.0722

/**
 * Take one exposure: grab the frame, mirror it so the preview reads like a mirror, and
 * reduce it to intensity. Returns the layer plus its own canvas for measuring.
 */
export function captureIntensity(video, maxW = 960) {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null

  const scale = Math.min(1, maxW / vw)
  const w = Math.round(vw * scale)
  const h = Math.round(vh * scale)

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.translate(w, 0)
  ctx.scale(-1, 1)
  ctx.drawImage(video, 0, 0, w, h)
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  const data = ctx.getImageData(0, 0, w, h).data
  const intensity = new Uint8ClampedArray(w * h)
  for (let p = 0, i = 0; p < intensity.length; p++, i += 4) {
    intensity[p] = LUMA_R * data[i] + LUMA_G * data[i + 1] + LUMA_B * data[i + 2]
  }
  return { intensity, width: w, height: h }
}

// Reuse one ImageData per canvas so sweeping the dial doesn't allocate a buffer per step.
const buffers = new WeakMap()

function bufferFor(canvas, ctx, w, h) {
  let buf = buffers.get(canvas)
  if (!buf || buf.width !== w || buf.height !== h) {
    buf = ctx.createImageData(w, h)
    buffers.set(canvas, buf)
  }
  return buf
}

/**
 * Render an intensity layer through a colormap. This is the only thing the dial does — the
 * intensity array is read, never written, so the measurement is provably untouched.
 */
export function drawMapped(canvas, layer, colormap) {
  if (canvas.width !== layer.width || canvas.height !== layer.height) {
    canvas.width = layer.width
    canvas.height = layer.height
  }
  const ctx = canvas.getContext('2d')
  const out = bufferFor(canvas, ctx, layer.width, layer.height)
  const d = out.data
  const src = layer.intensity
  const { lut } = colormap

  for (let p = 0, i = 0; p < src.length; p++, i += 4) {
    const v = src[p] * 3
    d[i] = lut[v]
    d[i + 1] = lut[v + 1]
    d[i + 2] = lut[v + 2]
    d[i + 3] = 255
  }
  ctx.putImageData(out, 0, 0)
}

/** The visitor's image in the palette they chose, as a JPEG data URL. */
export function mappedURL(layer, colormap, quality = 0.88) {
  const canvas = document.createElement('canvas')
  drawMapped(canvas, layer, colormap)
  return canvas.toDataURL('image/jpeg', quality)
}
