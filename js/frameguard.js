// Throwing away the frames that arrive broken.
//
// At 4K in Firefox on the exhibit machine the bottom of the viewfinder flashes, now and then,
// with a frame whose lower part is garbage. The camera is not sending them: ffmpeg decoded 534
// frames of the same 4K MJPG stream without a single complaint. They go wrong on the way
// through the browser, most likely because it is short of CPU and something reads a frame
// buffer while the next one is being written into it. So there is nothing upstream to switch
// off, and the only place left to catch them is here.
//
// What gives a torn frame away is that it is an **outlier in time**. A real change — a hand
// moving, somebody stepping in — carries on into the frame after it, so the frames either side
// of it differ from each other at least as much as either differs from it. A torn frame does
// not: the frame before and the frame after agree with each other, and it agrees with neither.
// That is a median filter's reasoning, and it is what lets this ignore motion instead of
// mistaking it for damage.
//
// The comparison is done on a 160-pixel-wide copy, in horizontal bands, from the bottom up —
// the flashing is always at the bottom, and a band has to be odd *and* joined to the bottom
// edge by other odd bands to count. Each band is judged in eight cells across and counts as
// odd only when nearly all of them are: a tear runs the full width of the picture, and a hand
// moving through the bottom of it does not. Judged as whole bands, a hand crossing a torn band
// excused the whole band — four tears in ten were let through that way in testing. Nothing here is judged on one frame alone, which is why the
// viewfinder runs one frame behind the camera: 33ms, which nobody can see, against a flash that
// everybody can.

const AW = 160
const BANDS = 16
const COLS = 8
// How many of a band's cells have to be odd for the band to be. Two spare, for a hand.
const COLS_NEEDED = COLS - 2
// A band counts as odd when it differs from both its neighbours by more than this, and by
// more than OVER times as much as the neighbours differ from each other plus SLACK. Mean
// absolute difference per channel, 0-255. The floor keeps sensor noise out of it: noise makes
// all three comparisons alike, so it can never pass the ratio, but the floor makes sure.
const MIN_JUMP = 14
const OVER = 2.5
const SLACK = 6

const probe = document.createElement('canvas')
let probeCtx = null

/** A small copy of a frame to compare with others. Null while there is nothing to copy. */
export function signatureOf(source) {
  const sw = source.videoWidth || source.width
  const sh = source.videoHeight || source.height
  if (!sw || !sh) return null
  const h = Math.max(BANDS, Math.round((AW * sh) / sw))
  if (probe.width !== AW || probe.height !== h) {
    probe.width = AW
    probe.height = h
    probeCtx = null
  }
  probeCtx ??= probe.getContext('2d', { willReadFrequently: true })
  probeCtx.imageSmoothingEnabled = true
  probeCtx.imageSmoothingQuality = 'medium'
  probeCtx.drawImage(source, 0, 0, AW, h)
  // getImageData hands back a fresh array every time, so this is safe to keep.
  return { w: AW, h, px: probeCtx.getImageData(0, 0, AW, h).data }
}

/** How far apart two signatures are, cell by cell: BANDS rows of COLS, top to bottom. */
function cellDiffs(a, b) {
  if (!a || !b || a.w !== b.w || a.h !== b.h) return null
  const sum = new Float64Array(BANDS * COLS)
  const n = new Float64Array(BANDS * COLS)
  for (let y = 0; y < a.h; y++) {
    const band = Math.min(BANDS - 1, Math.floor((y * BANDS) / a.h))
    for (let x = 0; x < a.w; x++) {
      const i = (y * a.w + x) * 4
      const cell = band * COLS + Math.min(COLS - 1, Math.floor((x * COLS) / a.w))
      sum[cell] += (Math.abs(a.px[i] - b.px[i]) + Math.abs(a.px[i + 1] - b.px[i + 1]) + Math.abs(a.px[i + 2] - b.px[i + 2])) / 3
      n[cell]++
    }
  }
  for (let i = 0; i < sum.length; i++) sum[i] /= n[i] || 1
  return sum
}

/**
 * Is `cur` torn? It is judged against the frame before it and the frame after it.
 *
 * Null when it is fine, or when there is not enough to judge by — a frame is only ever thrown
 * away on evidence. Otherwise how much of the picture was bad, from the bottom, and by how much.
 */
export function judge(prev, cur, next) {
  const a = cellDiffs(cur, prev)
  const c = cellDiffs(cur, next)
  const e = cellDiffs(prev, next)
  if (!a || !c || !e) return null
  const oddCell = (i) => Math.min(a[i], c[i]) > Math.max(MIN_JUMP, OVER * e[i] + SLACK)
  const odd = (band) => {
    let k = 0
    for (let col = 0; col < COLS; col++) if (oddCell(band * COLS + col)) k++
    return k >= COLS_NEEDED
  }
  if (!odd(BANDS - 1)) return null
  let top = BANDS - 1
  while (top > 0 && odd(top - 1)) top--
  // How far off the bottom band was, on its cells' own median — for the overlay, not the call.
  const last = []
  for (let col = 0; col < COLS; col++) {
    const i = (BANDS - 1) * COLS + col
    last.push(Math.min(a[i], c[i]))
  }
  last.sort((p, q) => p - q)
  return {
    // The share of the picture, measured up from the bottom, that was bad.
    share: (BANDS - top) / BANDS,
    jump: Math.round(last[COLS >> 1]),
  }
}

/**
 * The guard for one camera feed.
 *
 * In `both` it takes over the viewfinder: the video goes on playing, invisible, and what is on
 * screen is three canvases in rotation — the frame being shown, the one waiting to be judged,
 * and the one just arrived that it is judged against. Each frame is drawn exactly once, at the
 * size it is shown at, and a torn one is simply never made visible. In `capture` the viewfinder
 * is left alone and only the photograph is protected. `off` is how it was before.
 */
export function createFrameGuard(video, { host, zoom = () => 1, process = (v) => v, onReport = () => {} } = {}) {
  const views = [0, 1, 2].map(() => {
    const c = document.createElement('canvas')
    c.className = 'framed guard-view'
    c.hidden = true
    c.setAttribute('aria-hidden', 'true')
    host.append(c)
    return c
  })

  let mode = 'off'
  let shown = null // { canvas, sig } on screen now
  let pending = null // { canvas, sig } waiting for the frame after it
  let loop = 0
  let lastFrameAt = 0
  const stats = { seen: 0, preview: 0, capture: 0, last: '', cost: 0 }

  const report = () => onReport({ mode, ...stats })

  function note(tear, where) {
    stats[where]++
    stats.last = `${where}: bottom ${Math.round(tear.share * 100)}%, off by ${tear.jump}`
    report()
  }

  /** Back to the plain video, until a frame has been judged good enough to show. */
  function unguard() {
    shown = null
    pending = null
    for (const v of views) v.hidden = true
    host.classList.remove('guarded')
  }

  function show(item) {
    item.canvas.hidden = false
    for (const v of views) if (v !== item.canvas) v.hidden = true
    shown = item
    host.classList.add('guarded')
  }

  /** The canvases at the size the viewfinder actually shows, never more than the camera sends. */
  function fit() {
    const vw = video.videoWidth
    const vh = video.videoHeight
    // The video's own layout box, before any transform: the canvases share its class, so this
    // is their box too, turned or not.
    const bw = video.offsetWidth
    const bh = video.offsetHeight
    if (!vw || !vh || !bw || !bh) return false
    const cover = Math.max(bw / vw, bh / vh) * zoom() * (devicePixelRatio || 1)
    const w = Math.max(1, Math.min(vw, Math.round(vw * cover)))
    const h = Math.max(1, Math.min(vh, Math.round(vh * cover)))
    if (views[0].width !== w || views[0].height !== h) {
      for (const v of views) {
        v.width = w
        v.height = h
      }
      unguard()
    }
    return true
  }

  function onFrame() {
    const mine = loop
    if (mode !== 'both') return
    video.requestVideoFrameCallback(() => mine === loop && onFrame())
    lastFrameAt = performance.now()
    // Not on screen — the viewfinder is display: none on every step but the first. Nothing is
    // drawn and nothing is spent until it is back.
    if (!fit()) return

    const started = performance.now()
    const slot = views.find((v) => v !== shown?.canvas && v !== pending?.canvas)
    // Through `process` on the way, which is where the live denoise goes: whatever it hands back
    // — the frame cleaned, or the video untouched — is what is judged and what is shown.
    slot.getContext('2d').drawImage(process(video, slot.width, slot.height), 0, 0, slot.width, slot.height)
    // Taken from the canvas, not the video, so what is judged is exactly what would be shown.
    const incoming = { canvas: slot, sig: signatureOf(slot) }
    stats.seen++

    if (pending) {
      const tear = shown ? judge(shown.sig, pending.sig, incoming.sig) : null
      if (tear) note(tear, 'preview')
      else show(pending)
    }
    pending = incoming

    const took = performance.now() - started
    stats.cost = stats.cost ? stats.cost * 0.95 + took * 0.05 : took
    if (stats.seen % 30 === 0) report()
  }

  function start() {
    loop++
    unguard()
    if (mode !== 'both' || !video.requestVideoFrameCallback) return
    const mine = loop
    video.requestVideoFrameCallback(() => mine === loop && onFrame())
  }

  // A new stream, a new size: whatever was being shown belongs to the old one.
  video.addEventListener('loadedmetadata', start)

  // If frames stop being handed over while the video is still playing, give the screen back to
  // the video rather than leave it frozen on the last good frame. A browser that decides a
  // video nobody can see needs no frames would do exactly that.
  setInterval(() => {
    if (mode !== 'both' || video.paused || !video.videoWidth) return
    if (shown && performance.now() - lastFrameAt > 1000) start()
  }, 500)

  return {
    get mode() {
      return mode
    },

    setMode(next) {
      mode = next
      start()
      report()
    },

    /**
     * Hand `use` the next `count` frames that pass, one at a time, each one drawn onto a canvas
     * so the frame judged is the frame used. `use` must be done with it before it returns: the
     * canvas is reused for the frame after.
     *
     * Every frame is judged against the one before it and the one after, which costs two
     * frames — about 70ms at 30fps — on the shutter. Twice as many tries as frames wanted, and four
     * over, and then the last one is used anyway: a stream that is torn every time is a camera
     * problem, and a photograph of it is still better than none.
     */
    async eachClean(count, nextFrame, use) {
      if (mode === 'off') {
        for (let i = 0; i < count; i++) {
          use(video)
          if (i < count - 1) await nextFrame()
        }
        return count
      }
      const vw = video.videoWidth
      const vh = video.videoHeight
      if (!vw || !vh) return 0
      const pool = [0, 1].map(() => {
        const c = document.createElement('canvas')
        c.width = vw
        c.height = vh
        return c
      })
      const grab = (canvas) => {
        canvas.getContext('2d').drawImage(video, 0, 0, vw, vh)
        return { canvas, sig: signatureOf(canvas) }
      }

      let prev = signatureOf(video)
      await nextFrame()
      let cur = grab(pool[0])
      let used = 0
      for (let tries = 0; used < count && tries < count * 2 + 4; tries++) {
        await nextFrame()
        const next = grab(cur.canvas === pool[0] ? pool[1] : pool[0])
        const tear = judge(prev, cur.sig, next.sig)
        if (tear) {
          note(tear, 'capture')
        } else {
          use(cur.canvas)
          used++
          prev = cur.sig
        }
        cur = next
      }
      if (!used) {
        use(cur.canvas)
        used = 1
      }
      // Two 4K canvases are 66MB; do not leave them for the collector to find.
      for (const c of pool) c.width = c.height = 0
      return used
    },
  }
}
