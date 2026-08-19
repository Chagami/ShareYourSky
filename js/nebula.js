// The real-telescope panel beside the visitor's portrait.
//
// It has to be a SINGLE-CHANNEL intensity image for the piece to be honest: the point of the
// transfer beat is that the famous space picture is the same kind of measurement as their own
// photo, and the same dial recolours both. So this module returns exactly the same
// { intensity, width, height } shape that captureIntensity() does, and drawMapped() cannot
// tell the two apart.
//
// TO USE REAL DATA — do this before the exhibit opens:
//   Drop a grayscale image at public/nebula.png (a monochrome PNG/JPEG export of one filter's
//   exposure, e.g. an Hubble Hα frame from hubblesite.org or an SDSS/DSS plate). It is loaded
//   automatically and the synthetic fallback below is never used. Update NEBULA_CREDIT to name
//   the object and the source — a real exhibit must caption real data.

const NEBULA_URL = 'nebula.png'

// `label` is what the visitor reads under the pane. It must never claim to be real data
// while the synthetic placeholder is in use — name the real object and mission here once you
// have dropped a frame in.
export const NEBULA_CREDIT = {
  label: 'Simulated frame — placeholder',
  real: false,
}

const REAL_LABEL = 'Real telescope data' // e.g. 'M16 · Hubble/WFC3 · Ha'

/** Reduce a loaded image to intensity, cropped to the requested aspect ratio. */
function imageToIntensity(img, w, h) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  // Cover-crop so the frame fills the pane without distorting it.
  const scale = Math.max(w / img.width, h / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)

  const data = ctx.getImageData(0, 0, w, h).data
  const intensity = new Uint8ClampedArray(w * h)
  for (let p = 0, i = 0; p < intensity.length; p++, i += 4) {
    intensity[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
  }
  return { intensity, width: w, height: h }
}

/**
 * Load the telescope frame at the visitor portrait's dimensions, so the two panes match.
 * Falls back to a synthetic field if no real frame has been dropped in yet.
 */
export async function loadNebula(w, h) {
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = reject
      el.src = NEBULA_URL
    })
    NEBULA_CREDIT.label = REAL_LABEL
    NEBULA_CREDIT.real = true
    return imageToIntensity(img, w, h)
  } catch {
    console.info(
      '[nebula] No public/nebula.png found — using the synthetic placeholder. ' +
      'Drop a single-filter grayscale frame there and update REAL_LABEL in js/nebula.js.'
    )
    return syntheticNebula(w, h)
  }
}

// ── synthetic fallback ──────────────────────────────────────────────────────
// Seeded so the "nebula" is identical every session — an exhibit that looks different
// each morning invites questions you don't want to answer.

function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Value-noise grid with bilinear sampling. */
function noiseGrid(rand, cols, rows) {
  const g = new Float32Array(cols * rows)
  for (let i = 0; i < g.length; i++) g[i] = rand()
  return (u, v) => {
    const x = u * (cols - 1)
    const y = v * (rows - 1)
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const x1 = Math.min(cols - 1, x0 + 1)
    const y1 = Math.min(rows - 1, y0 + 1)
    const fx = x - x0
    const fy = y - y0
    const sx = fx * fx * (3 - 2 * fx) // smoothstep, so octaves don't show grid creases
    const sy = fy * fy * (3 - 2 * fy)
    const a = g[y0 * cols + x0] + (g[y0 * cols + x1] - g[y0 * cols + x0]) * sx
    const b = g[y1 * cols + x0] + (g[y1 * cols + x1] - g[y1 * cols + x0]) * sx
    return a + (b - a) * sy
  }
}

export function syntheticNebula(w, h) {
  const rand = mulberry32(20260818)
  const octaves = [3, 6, 12, 24, 48].map((n) => noiseGrid(rand, n, Math.max(2, Math.round(n * (h / w)))))
  const cores = [
    { x: 0.42, y: 0.46, r: 0.30, gain: 1.0 },
    { x: 0.66, y: 0.62, r: 0.18, gain: 0.7 },
    { x: 0.30, y: 0.66, r: 0.14, gain: 0.45 },
  ]

  const field = new Float32Array(w * h)
  let peak = 0

  for (let y = 0; y < h; y++) {
    const v = y / (h - 1)
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1)

      // Filamentary structure: ridged noise reads as gas, plain noise reads as static.
      let n = 0
      let amp = 0.5
      for (const oct of octaves) {
        n += (1 - Math.abs(2 * oct(u, v) - 1)) * amp
        amp *= 0.55
      }

      // Bright cores with soft falloff, so there is real dynamic range to map.
      let glow = 0
      for (const c of cores) {
        const dx = (u - c.x) * (w / h)
        const dy = v - c.y
        glow += c.gain * Math.exp(-((dx * dx + dy * dy) / (2 * c.r * c.r)))
      }

      const val = n * (0.25 + 1.5 * glow) + 0.04 * glow
      field[y * w + x] = val
      if (val > peak) peak = val
    }
  }

  const intensity = new Uint8ClampedArray(w * h)
  for (let p = 0; p < field.length; p++) {
    // Mild gamma so the faint structure survives, like a stretched astronomical frame.
    intensity[p] = Math.pow(Math.min(1, field[p] / peak), 0.75) * 255
  }

  // A handful of foreground stars.
  const stars = 90
  for (let s = 0; s < stars; s++) {
    const cx = Math.floor(rand() * w)
    const cy = Math.floor(rand() * h)
    const bright = 160 + rand() * 95
    const spread = 1 + Math.floor(rand() * 2)
    for (let dy = -spread; dy <= spread; dy++) {
      for (let dx = -spread; dx <= spread; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= w || y >= h) continue
        const falloff = Math.exp(-(dx * dx + dy * dy) / 1.6)
        const p = y * w + x
        intensity[p] = Math.max(intensity[p], bright * falloff)
      }
    }
  }

  return { intensity, width: w, height: h }
}
