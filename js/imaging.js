// Image pipeline: one exposure -> three channel planes -> per-channel levels -> composite.
//
// The capture is split into its real red, green and blue planes once. Everything the visitor
// does afterwards is a per-channel levels curve (a black point and a white point) applied as a
// 256-entry lookup table. The planes are written once and only ever read, so the underlying
// measurement is never destroyed no matter how far the levels are pushed.

export const CHANNELS = [
  // `hue` is where this channel's light actually sits on the spectrum, which is not quite
  // where `accent` sits — the accents are softened for a dark screen, and a marker claiming to
  // show "the colour this light really is" has to point at the real thing.
  { key: 'R', label: 'Red', accent: '#ff5252', rgb: [255, 82, 82], hue: 0 },
  { key: 'G', label: 'Green', accent: '#3ddc6b', rgb: [61, 220, 107], hue: 120 },
  { key: 'B', label: 'Blue', accent: '#4d94ff', rgb: [77, 148, 255], hue: 240 },
]

// Rec. 709 luma, matching CSS `filter: grayscale()` so a CSS-desaturated preview and the
// greyscale we compute here are the same image.
const LUMA = [0.2126, 0.7152, 0.0722]

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v)

/**
 * Take the exposure: grab the frame mirrored, then split it into planes plus a luma plane.
 * Everything downstream needs is computed once, here.
 */
export function captureFrame(video, maxEdge = 2600, rotate = 0, crop = null) {
  // A video, or a canvas holding one of its frames — which is how the frame guard hands over
  // the frame it actually checked, rather than whatever the video has moved on to since.
  const vw = video.videoWidth || video.width
  const vh = video.videoHeight || video.height
  if (!vw || !vh) return null

  // A camera mounted sideways delivers a sideways stream, and the live view is corrected with
  // a CSS transform — but `drawImage` reads the *raw* frame, not what the transform made of
  // it. So the same correction has to be applied again here, or the photo comes out at ninety
  // degrees to the viewfinder the visitor was looking at.
  const rot = ((Math.round(rotate / 90) * 90) % 360 + 360) % 360
  const upright = rot === 90 || rot === 270
  const srcW = upright ? vh : vw
  const srcH = upright ? vw : vh

  // Bounded on the longest edge, not on the width. Width alone means the bracket decides how
  // much of the sensor survives: a camera turned on its side delivers a portrait frame, whose
  // width is its *short* edge, so the same 4K camera kept twice the pixels mounted sideways as
  // it did mounted straight.
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH))
  const width = Math.round(srcW * scale)
  const height = Math.round(srcH * scale)

  // The crop is given as fractions trimmed off each edge of what the viewfinder shows, so it
  // is in screen coordinates — after the turn and after the mirror. The kept window has to keep
  // the frame's shape, which is why trimming one axis trims the other to match; the viewfinder
  // does the same, and that is what makes the photograph agree with what was on screen.
  const cl = crop?.l ?? 0
  const crr = crop?.r ?? 0
  const ctp = crop?.t ?? 0
  const cb = crop?.b ?? 0
  const zoom = Math.max(1 / Math.max(0.2, 1 - cl - crr), 1 / Math.max(0.2, 1 - ctp - cb))
  const outW = Math.max(1, Math.round(width / zoom))
  const outH = Math.max(1, Math.round(height / zoom))
  // Where the middle of the kept window falls in the full turned picture.
  const cx = width * ((cl + 1 - crr) / 2)
  const cy = height * ((ctp + 1 - cb) / 2)

  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  // The browser's own resampler, which is a proper filter rather than nearest neighbour.
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // Work from the middle: put the window's centre at the middle of the canvas, then rotate,
  // mirror, and draw the frame centred on the origin. Done this way the order is the same
  // whatever the rotation, and the mirror stays a mirror rather than becoming a vertical flip
  // on the quarter turns. With no crop this comes to translate(width / 2, height / 2), which is
  // what it was before there was one.
  ctx.translate(outW / 2 + width / 2 - cx, outH / 2 + height / 2 - cy)
  if (rot) ctx.rotate((rot * Math.PI) / 180)
  ctx.scale(-1, 1) // mirror, so the live feed reads like a mirror
  ctx.drawImage(video, (-vw * scale) / 2, (-vh * scale) / 2, vw * scale, vh * scale)
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  return framePixels(ctx, outW, outH)
}

/**
 * The same frame structure, from a still image instead of the camera.
 *
 * No rotation and no mirror. Those exist because a camera bolted to a bracket delivers a
 * sideways picture of a room that a person is standing in front of; a photograph of a nebula
 * is already the right way up, and flipping it would be a small lie about the sky.
 */
export function frameFromImage(img, maxEdge = 1400) {
  const iw = img.naturalWidth
  const ih = img.naturalHeight
  if (!iw || !ih) return null

  // Longest edge, as in captureFrame, so a portrait picture is not quietly kept at twice the
  // detail of a landscape one.
  const scale = Math.min(1, maxEdge / Math.max(iw, ih))
  const width = Math.round(iw * scale)
  const height = Math.round(ih * scale)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, width, height)

  return framePixels(ctx, width, height)
}

/**
 * Read a drawn canvas into the three 8-bit planes everything downstream works on.
 *
 * De-interleaving once here is what makes every later pass cheap: a levels change is then a
 * lookup per plane rather than a stride-4 walk of RGBA, and a histogram is a count over a flat
 * array. `rest` is where each channel's light actually sits, which is where its handles open.
 */
function framePixels(ctx, width, height) {
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

  const histograms = planes.map(histogram)
  return { width, height, planes, luma, histograms, rest: histograms.map(restingLevels) }
}

/* Never let a resting handle sit flush with the end of the track: there it reads as part of
   the chart's frame rather than as an object on it, and the slide-in that introduces it has
   nowhere to travel from. Sixteen levels out of 255 is about 33px in on the walkthrough chart,
   which clearly detaches the handle from the corner; ten looked flush. The exhibit camera sees
   a lit room, so this floor binds on the dark end fairly often — but crushing the bottom 6% of
   the shadows is exactly what an auto-levels would do anyway, and it is invisible on screen. */
const MIN_INSET = 16
const MIN_SPAN = 40

/**
 * Where this channel's light actually sits, as a black and white point to open on.
 *
 * Resting at 0 and 255 costs more than it looks. The handles sit half off each end of the
 * chart, so they read as end-caps; and a visitor's first exploratory drag of the white point
 * can travel a long way before it touches a single pixel, which reads as a broken control.
 * Opening on the 0.5th and 99.5th percentile means the very first movement does something.
 */
export function restingLevels(bins) {
  let total = 0
  for (let v = 0; v < 256; v++) total += bins[v]
  if (!total) return { black: MIN_INSET, white: 255 - MIN_INSET }

  const percentile = (fraction) => {
    const target = total * fraction
    let seen = 0
    for (let v = 0; v < 256; v++) {
      seen += bins[v]
      if (seen >= target) return v
    }
    return 255
  }

  const black = Math.min(Math.max(percentile(0.005), MIN_INSET), 255 - MIN_INSET - MIN_SPAN)
  const white = Math.max(Math.min(percentile(0.995), 255 - MIN_INSET), black + MIN_SPAN)
  return { black, white }
}

/**
 * A smaller copy of a frame, for the thumbnails and the preview.
 *
 * Every one of those redraws on every drag, and at capture resolution that is four full-frame
 * passes per pointermove. Nearest-neighbour off the planes is cheap, runs once, and nothing
 * downstream can tell the difference at the size these are shown.
 */
/**
 * A smaller copy of a frame, bounded on its longest edge.
 *
 * Every output pixel is the average of the source pixels it covers, rather than whichever one
 * happened to land under a rounded coordinate. Nearest neighbour is what this did before, and
 * throwing away three pixels in four is how a sharp picture becomes a crunchy one: fine detail
 * does not soften, it aliases, and on a face that reads as noise around the eyes and hair.
 */
export function downscaleFrame(frame, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(frame.width, frame.height))
  // Already small enough. Sharing the frame is safe — nothing mutates one once it is built.
  if (scale === 1) return frame

  const width = Math.max(1, Math.round(frame.width * scale))
  const height = Math.max(1, Math.round(frame.height * scale))
  const n = width * height
  const planes = [new Uint8ClampedArray(n), new Uint8ClampedArray(n), new Uint8ClampedArray(n)]
  const luma = new Uint8ClampedArray(n)
  const [s0, s1, s2] = frame.planes
  const sl = frame.luma

  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * frame.height) / height)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * frame.height) / height))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * frame.width) / width)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * frame.width) / width))

      let a = 0
      let b = 0
      let c = 0
      let l = 0
      let count = 0
      for (let sy = y0; sy < y1; sy++) {
        const row = sy * frame.width
        for (let sx = x0; sx < x1; sx++) {
          const si = row + sx
          a += s0[si]
          b += s1[si]
          c += s2[si]
          l += sl[si]
          count++
        }
      }
      const di = y * width + x
      planes[0][di] = a / count
      planes[1][di] = b / count
      planes[2][di] = c / count
      luma[di] = l / count
    }
  }
  return { width, height, planes, luma }
}

/**
 * Average several captures of the same scene into one.
 *
 * The astrophotographer's answer to a noisy sensor, and the reason it is the one offered first:
 * the noise is different in every frame and the picture is the same in all of them, so adding
 * them up and dividing leaves the picture alone and divides the noise by the square root of how
 * many there were. Four frames is half the noise, nine is a third. Every photograph of the kind
 * this exhibit is about was made this way, out of far more than nine.
 *
 * Nothing is lost that a blur would lose — no detail is softened, because no pixel is ever
 * mixed with its neighbours. What it costs instead is time and stillness: the frames are taken
 * over a fraction of a second, and anything that moves in that time smears rather than
 * sharpening. For somebody standing still in front of a camera that is a good trade, which is
 * not true of every subject.
 */
export function stackFrames(shots) {
  const first = shots[0]
  if (!first || shots.length === 1) return first ?? null

  const { width, height } = first
  const n = width * height
  // 16-bit would overflow at 257 frames and 8-bit at two; this is the cheap safe width.
  const acc = [new Uint32Array(n), new Uint32Array(n), new Uint32Array(n)]
  let used = 0

  for (const shot of shots) {
    // A capture that came back a different size is one taken across a resize. Skipping it is
    // better than either stretching it or throwing the whole stack away.
    if (!shot || shot.width !== width || shot.height !== height) continue
    used++
    for (let c = 0; c < 3; c++) {
      const src = shot.planes[c]
      const dst = acc[c]
      for (let i = 0; i < n; i++) dst[i] += src[i]
    }
  }
  if (used < 2) return first

  const planes = [new Uint8ClampedArray(n), new Uint8ClampedArray(n), new Uint8ClampedArray(n)]
  const luma = new Uint8ClampedArray(n)
  const half = used >> 1 // round rather than floor: over a whole frame the bias is visible
  for (let i = 0; i < n; i++) {
    const r = (acc[0][i] + half) / used
    const g = (acc[1][i] + half) / used
    const b = (acc[2][i] + half) / used
    planes[0][i] = r
    planes[1][i] = g
    planes[2][i] = b
    luma[i] = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b
  }
  return withStats(width, height, planes, luma)
}

/**
 * Smooth the flat parts of a picture and leave the edges alone.
 *
 * A sigma filter: each pixel becomes the average of the neighbours that are already close to
 * it in value, and neighbours further away than `tolerance` are simply not counted. In a flat
 * area every neighbour qualifies and the result is a nine-pixel average, which is most of the
 * noise gone. On an edge only the neighbours on the same side of it qualify, so the edge is
 * averaged along rather than across and stays where it was — which is the whole difference
 * between this and a blur, and the reason a blur is not offered.
 *
 * The tolerance is not a fixed number of levels but a multiple of the frame's own noise,
 * measured off the frame. A fixed one cannot work: set it below the noise and almost no
 * neighbour qualifies, so nothing is averaged and the filter does nothing — which is exactly
 * what 12 levels did against a sensor spreading 15. Set it high enough for that sensor and it
 * is far too blunt for a clean one. Two and a half sigma takes in nearly every neighbour that
 * differs only by noise and nearly none that differs because the picture does.
 *
 * For a single frame of a subject that will not hold still. Stacking is better where it can be
 * used, because it invents nothing.
 */
export function denoiseFrame(frame, strength = 2.5) {
  const tolerance = Math.max(3, Math.round(strength * estimateNoise(frame)))
  const { width, height } = frame
  const n = width * height
  const planes = frame.planes.map((src) => {
    const out = new Uint8ClampedArray(n)
    for (let y = 0; y < height; y++) {
      const up = y > 0 ? -width : 0
      const down = y < height - 1 ? width : 0
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        const mid = src[i]
        const left = x > 0 ? -1 : 0
        const right = x < width - 1 ? 1 : 0
        let sum = 0
        let count = 0
        for (const dy of [up, 0, down]) {
          for (const dx of [left, 0, right]) {
            const v = src[i + dy + dx]
            // Within tolerance of the middle: part of the same flat area, so worth averaging
            // with. Outside it: the other side of an edge, and averaging across that is what
            // turns a photograph into a smear.
            if (v - mid <= tolerance && mid - v <= tolerance) {
              sum += v
              count++
            }
          }
        }
        out[i] = sum / count
      }
    }
    return out
  })

  const luma = new Uint8ClampedArray(n)
  for (let i = 0; i < n; i++) {
    luma[i] = LUMA[0] * planes[0][i] + LUMA[1] * planes[1][i] + LUMA[2] * planes[2][i]
  }
  return withStats(width, height, planes, luma)
}

/**
 * Roughly how much noise is on this frame, in levels.
 *
 * The spread of the difference between neighbouring pixels, taken as a median rather than a
 * mean so that the edges in the picture — which are large and rare — do not drag it upwards the
 * way they would an average. 1.4826 turns a median absolute deviation into the equivalent
 * standard deviation, and the root two undoes the fact that a difference of two noisy pixels is
 * noisier than either of them.
 */
export function estimateNoise(frame) {
  const { width, height, luma } = frame
  const diffs = []
  // A sample, not a sweep: five thousand differences settle the median and cost nothing.
  const stepY = Math.max(1, Math.floor(height / 70))
  const stepX = Math.max(1, Math.floor(width / 70))
  for (let y = 0; y < height; y += stepY) {
    const row = y * width
    for (let x = 0; x + 1 < width; x += stepX) {
      diffs.push(Math.abs(luma[row + x + 1] - luma[row + x]))
    }
  }
  if (!diffs.length) return 0
  diffs.sort((a, b) => a - b)
  const median = diffs[diffs.length >> 1]
  return (1.4826 * median) / Math.SQRT2
}

/** A frame is its pixels plus what they add up to; anything that rewrites the one redoes the other. */
function withStats(width, height, planes, luma) {
  const histograms = planes.map(histogram)
  return { width, height, planes, luma, histograms, rest: histograms.map(restingLevels) }
}

/**
 * How much the opening levels multiply what the sensor gave.
 *
 * Nothing in this pipeline creates noise — the capture resamples with a real filter and every
 * smaller copy is a box average, and both of those *reduce* it. This is the one place it gets
 * worse: the handles open on the 0.5th and 99.5th percentile, and stretching that range to fill
 * 0–255 multiplies everything inside it, noise included, by 255 / (white - black). The dimmer
 * the room the narrower the range the camera actually used, and the bigger this number.
 */
export function levelsGain(rest) {
  return rest.map((r) => 255 / Math.max(1, r.white - r.black))
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

/** A channel switched off. Step 2 builds a picture up out of these, one colour at a time. */
export const ZERO_LUT = new Uint8ClampedArray(256)

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
/**
 * The colour a hue is, as weights on the three outputs.
 *
 * This is hsl(deg, 100%, 50%) with the algebra done in the open: fully saturated, so one weight
 * is always 1 and one is always 0. The three primaries land exactly on 0, 120 and 240, which is
 * what makes an untouched picture come out of the tinted path bit-for-bit identical to a plain
 * copy of the sensor's own channels.
 */
export function hueTint(deg) {
  // Anything that is not a number is red. A hue of NaN indexes the table below with NaN, which
  // returns undefined, and an undefined tint takes the whole composite down — every picture
  // after it is a blank canvas. Better a wrong colour than a broken exhibit.
  const safe = Number.isFinite(deg) ? deg : 0
  const h = ((((safe % 360) + 360) % 360) / 60)
  const x = 1 - Math.abs((h % 2) - 1)
  return [
    [1, x, 0], [x, 1, 0], [0, 1, x],
    [0, x, 1], [x, 0, 1], [1, 0, x],
  ][Math.floor(h) % 6]
}

/** Each channel shown as its own colour — what a camera does. */
export const RGB_TINTS = CHANNELS.map((c) => hueTint(c.hue))

/**
 * Add the three channels together, each in whatever colour it has been given.
 *
 * This is the narrowband composite: every filter produces one greyscale exposure, the
 * astrophotographer assigns each of them a colour, and the picture is their sum. Feed it the
 * three primaries and the sum collapses back to plain RGB, so there is only one code path here
 * and every screen in the piece uses it.
 *
 * The nine 256-entry tables are the whole trick. Doing it directly would be nine multiplies a
 * pixel — a million and a third of those per frame, on a tablet, while a finger is moving. With
 * each channel's levels folded into a per-value table it is nine array reads instead, and the
 * destination being a Uint8ClampedArray means the sums clamp themselves for free.
 */
export function drawComposite(canvas, frame, luts, tints = RGB_TINTS) {
  const ctx = fit(canvas, frame)
  const out = bufferFor(canvas, ctx, frame.width, frame.height)
  const d = out.data
  const [p0, p1, p2] = frame.planes

  const table = []
  for (let src = 0; src < 3; src++) {
    // The lookup table follows its plane, not the colour it is being shown in: a channel's
    // black and white points belong to the light it collected, wherever that light ends up.
    const lut = luts[src]
    for (let outIdx = 0; outIdx < 3; outIdx++) {
      const weight = tints[src][outIdx]
      const column = new Uint8Array(256)
      if (weight) for (let v = 0; v < 256; v++) column[v] = lut[v] * weight
      table.push(column)
    }
  }
  const [r0, g0, b0, r1, g1, b1, r2, g2, b2] = table

  for (let p = 0, i = 0; p < p0.length; p++, i += 4) {
    const a = p0[p]
    const b = p1[p]
    const c = p2[p]
    d[i] = r0[a] + r1[b] + r2[c]
    d[i + 1] = g0[a] + g1[b] + g2[c]
    d[i + 2] = b0[a] + b1[b] + b2[c]
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
/**
 * The picture as a file, for the wall.
 *
 * 0.95 rather than the 0.88 this used to be. JPEG at 0.88 is where ringing starts to show on
 * the hard edges this piece is full of — a crushed channel makes plenty of them. Going all the
 * way to 1.0 nearly triples the file for no visible gain, and the wall loads forty of these at
 * once; 0.95 is the point where the artefacts stop and the size has not run away.
 */
export function compositeURL(frame, luts, tints = RGB_TINTS, quality = 0.95) {
  const canvas = document.createElement('canvas')
  drawComposite(canvas, frame, luts, tints)
  return canvas.toDataURL('image/jpeg', quality)
}
