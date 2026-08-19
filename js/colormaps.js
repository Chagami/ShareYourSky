// Colormaps: intensity (0-255) -> colour. One 256-entry RGB lookup table each.
//
// This is the whole argument of the piece in one data structure. The measurement is a single
// brightness value per pixel and it never changes; a colormap only decides how that value is
// shown. Grayscale is first on the dial deliberately — it is the un-chosen option, the raw
// measurement, so turning away from it is visibly an authored decision.
//
// To add a palette, add an entry here. Anchors are [position 0..1, '#rrggbb'] and are
// interpolated linearly in sRGB — good enough for a prototype, and it keeps the ramps
// editable by hand without a colour-science dependency.

const PALETTES = [
  {
    name: 'Grayscale',
    note: 'the raw measurement',
    anchors: [[0, '#000000'], [1, '#ffffff']],
  },
  {
    name: 'Duotone',
    note: 'one hue, dark to light',
    anchors: [[0, '#05070d'], [0.5, '#1f5fa8'], [1, '#f2f6ff']],
  },
  {
    name: 'Viridis',
    note: 'perceptually even — the scientific default',
    anchors: [
      [0, '#440154'], [0.25, '#414487'], [0.45, '#2a788e'],
      [0.65, '#22a884'], [0.85, '#7ad151'], [1, '#fde725'],
    ],
  },
  {
    name: 'Inferno',
    note: 'heat — bright means hot',
    anchors: [
      [0, '#000004'], [0.25, '#420a68'], [0.5, '#932667'],
      [0.7, '#dd513a'], [0.87, '#fca50a'], [1, '#fcffa4'],
    ],
  },
  {
    name: 'Hubble-ish',
    note: 'the look you know from space photos',
    anchors: [
      [0, '#04101c'], [0.3, '#0e4d5c'], [0.55, '#3f8f7a'],
      [0.8, '#c2a35a'], [1, '#f8ecd2'],
    ],
  },
]

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]

/** Expand anchor points into a flat 256*3 Uint8ClampedArray. */
function buildLut(anchors) {
  const stops = anchors.map(([at, hex]) => ({ at, rgb: hexToRgb(hex) }))
  const lut = new Uint8ClampedArray(256 * 3)

  for (let v = 0; v < 256; v++) {
    const x = v / 255
    let hi = 1
    while (hi < stops.length - 1 && stops[hi].at < x) hi++
    const a = stops[hi - 1]
    const b = stops[hi]
    const span = b.at - a.at
    const f = span <= 0 ? 0 : (x - a.at) / span
    for (let k = 0; k < 3; k++) {
      lut[v * 3 + k] = a.rgb[k] + (b.rgb[k] - a.rgb[k]) * f
    }
  }
  return lut
}

export const COLORMAPS = PALETTES.map((p) => ({ ...p, lut: buildLut(p.anchors) }))

/** A wide strip of the palette, for the readout beside the dial. */
export function drawSwatch(canvas, colormap) {
  const w = canvas.width
  const h = canvas.height
  const ctx = canvas.getContext('2d')
  const out = ctx.createImageData(w, h)
  const { lut } = colormap

  for (let x = 0; x < w; x++) {
    const v = Math.round((x / Math.max(1, w - 1)) * 255) * 3
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4
      out.data[i] = lut[v]
      out.data[i + 1] = lut[v + 1]
      out.data[i + 2] = lut[v + 2]
      out.data[i + 3] = 255
    }
  }
  ctx.putImageData(out, 0, 0)
}
