// Image pipeline: capture -> real R/G/B channel separation -> weighted recombination.
//
// The three channels are the actual red, green and blue planes measured in the visitor's
// photo — not three tinted copies of its brightness. Each card shows one plane in its own
// colour, and the composite writes each plane back into its own output channel, scaled by
// that channel's slider.
//
// The consequence is the exhibit's argument: with all three sliders at 100% the composite
// reconstructs the captured photo *exactly*, pixel for pixel. Neutral is the truth, and
// every other setting is visibly a choice. Rewrite drawComposite() to change that.

export const CHANNELS = [
  { key: 'R', label: 'Red', rgb: [255, 0, 0], accent: '#ff4d4d' },
  { key: 'G', label: 'Green', rgb: [0, 255, 0], accent: '#3ddc6b' },
  { key: 'B', label: 'Blue', rgb: [0, 0, 255], accent: '#4d94ff' },
]

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v)

/**
 * Grab the current video frame, mirrored so the live feed reads like a mirror.
 * Returns the color canvas plus a JPEG data URL of it.
 */
export function captureFrame(video, maxW = 960) {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null

  const scale = Math.min(1, maxW / vw)
  const w = Math.round(vw * scale)
  const h = Math.round(vh * scale)

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.translate(w, 0)
  ctx.scale(-1, 1)
  ctx.drawImage(video, 0, 0, w, h)

  return { canvas, colorURL: canvas.toDataURL('image/jpeg', 0.9), width: w, height: h }
}

/**
 * Split a colour canvas into one plane per channel, optionally downscaled. A small "work"
 * set keeps the sliders at 60fps; the full-size set is only built on publish.
 */
export function channelLayers(canvas, maxW) {
  const scale = Math.min(1, maxW / canvas.width)
  const w = Math.max(1, Math.round(canvas.width * scale))
  const h = Math.max(1, Math.round(canvas.height * scale))

  let src = canvas
  if (scale < 1) {
    src = document.createElement('canvas')
    src.width = w
    src.height = h
    src.getContext('2d').drawImage(canvas, 0, 0, w, h)
  }

  const data = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data
  const planes = CHANNELS.map(() => new Uint8ClampedArray(w * h))
  for (let p = 0, i = 0; p < planes[0].length; p++, i += 4) {
    planes[0][p] = data[i]
    planes[1][p] = data[i + 1]
    planes[2][p] = data[i + 2]
  }
  return { planes, width: w, height: h }
}

// Reuse one ImageData per canvas so dragging a slider doesn't allocate a new buffer per frame.
const buffers = new WeakMap()

function bufferFor(canvas, ctx, w, h) {
  let buf = buffers.get(canvas)
  if (!buf || buf.width !== w || buf.height !== h) {
    buf = ctx.createImageData(w, h)
    buffers.set(canvas, buf)
  }
  return buf
}

function fit(canvas, layers) {
  if (canvas.width !== layers.width || canvas.height !== layers.height) {
    canvas.width = layers.width
    canvas.height = layers.height
  }
  return canvas.getContext('2d')
}

/** Render one measured channel in its own colour, scaled by its weight. */
export function drawChannel(canvas, layers, channelIndex, weight) {
  const [cr, cg, cb] = CHANNELS[channelIndex].rgb
  const plane = layers.planes[channelIndex]
  const ctx = fit(canvas, layers)
  const out = bufferFor(canvas, ctx, layers.width, layers.height)
  const d = out.data

  for (let p = 0, i = 0; p < plane.length; p++, i += 4) {
    const v = plane[p] * weight
    d[i] = clamp255((cr / 255) * v)
    d[i + 1] = clamp255((cg / 255) * v)
    d[i + 2] = clamp255((cb / 255) * v)
    d[i + 3] = 255
  }
  ctx.putImageData(out, 0, 0)
}

/**
 * Put the three measured planes back together, each weighted by its slider. Written as a
 * 3x3 mix so a different channel palette still recombines correctly; with the pure
 * primaries above it reduces to "each plane back into its own output channel", which is
 * what makes 100/100/100 an exact reconstruction of the capture.
 */
export function drawComposite(canvas, layers, weights) {
  const ctx = fit(canvas, layers)
  const out = bufferFor(canvas, ctx, layers.width, layers.height)
  const d = out.data
  const { planes } = layers

  const mix = CHANNELS.map((channel, c) => channel.rgb.map((component) => (component / 255) * weights[c]))

  for (let p = 0, i = 0; p < planes[0].length; p++, i += 4) {
    let r = 0
    let g = 0
    let b = 0
    for (let c = 0; c < mix.length; c++) {
      const v = planes[c][p]
      r += v * mix[c][0]
      g += v * mix[c][1]
      b += v * mix[c][2]
    }
    d[i] = clamp255(r)
    d[i + 1] = clamp255(g)
    d[i + 2] = clamp255(b)
    d[i + 3] = 255
  }
  ctx.putImageData(out, 0, 0)
}

/** Full-resolution composite as a JPEG data URL, for the gallery wall. */
export function compositeURL(layers, weights, quality = 0.88) {
  const canvas = document.createElement('canvas')
  drawComposite(canvas, layers, weights)
  return canvas.toDataURL('image/jpeg', quality)
}
