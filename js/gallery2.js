// The gallery wall, rows design — kept at gallery2.html for comparison against the stacking
// wall at gallery.html. One screen of four.
//
// A packed, asymmetric field of pictures. Most are from the curated folder; a quarter are
// visitors' own. The curated ones drift, one crossfading to something new every half minute.
// The visitors' ones sit still until somebody shares another, and then the newest arrives with
// a light on it.
//
// The four screens each run this file. They do not talk to each other — the server keeps the
// register of who is holding what (see server/gallery.js), which is the only way any of them
// can avoid showing the same picture as the one next to it.

import { CHANNELS } from './imaging.js'
import { list, subscribe } from './store.js'

// ── the knobs ───────────────────────────────────────────────────────────────

const WALL = {
  /** How many pictures one screen holds at once. Four screens, so the wall shows 4× this. */
  tiles: 10,

  /** ...of which this fraction are visitors' own, rounded to at least one. */
  communityShare: 0.25,

  /** A tile crossfades to something new this often. One at a time, not all together. */
  rotateEvery: 30000,

  /** How long that crossfade takes. Long enough to read as a dissolve, not a cut. */
  fade: 1800,

  /**
   * How far a picture's area may sit from the average before the layout starts trading fill for
   * evenness. A target, not a promise: nothing is cropped, so the shapes are the pictures' own
   * and there is only so evenly a fixed set of shapes can be made to sit.
   */
  sizeJitter: 0.3,

  /** How hard to push for a full screen against how hard to push for even sizes. */
  weightFill: 2,
  weightEven: 2.5,

  /** Space between pictures, in pixels. Half of it again around the outside. */
  gap: 12,

  /** Tell the server we are still here, so a dead screen's pictures return to circulation. */
  beat: 12000,
}

const API = 'api/gallery'
const grid = document.getElementById('grid')
const empty = document.getElementById('empty')

// ── laying the wall out ─────────────────────────────────────────────────────

/**
 * Rows of pictures, every picture at its own true proportions and none of them cropped.
 *
 * Each row is stretched to the full width, so its height falls out of the aspects in it; the
 * whole stack is then scaled to the screen's height and every row centred. What is left over
 * shows as an even margin either side of the shorter rows rather than as a hole or a ragged
 * edge — which is where the small amount of empty wall goes.
 *
 * Cropping would make this trivial and a partition of the screen would fill it exactly, but
 * both mean cutting into somebody's photograph. So the layout gives up a tenth of the wall
 * instead, and picks which tenth carefully.
 */
function fitRows(items, cuts, W, H, gap) {
  const rows = []
  let at = 0
  for (const c of [...cuts, items.length]) {
    rows.push(items.slice(at, c))
    at = c
  }
  if (rows.some((r) => !r.length)) return null

  // The height each row wants, to span the width at these proportions.
  const natural = rows.map((r) => (W - (r.length - 1) * gap) / r.reduce((sum, it) => sum + ar(it), 0))
  const stack = natural.reduce((sum, h) => sum + h, 0)
  // Rows too short to reach the bottom even at full width: scaling *up* would push them off
  // the sides, and cropping them back is the one thing this layout will not do.
  if (stack + (rows.length - 1) * gap < H) return null

  const scale = (H - (rows.length - 1) * gap) / stack
  const heights = natural.map((h) => h * scale)

  const areas = []
  rows.forEach((r, i) => r.forEach((it) => areas.push(ar(it) * heights[i] * heights[i])))
  const mean = areas.reduce((sum, a) => sum + a, 0) / areas.length

  return {
    rows,
    heights,
    covered: areas.reduce((sum, a) => sum + a, 0) / (W * H),
    spread: Math.max(...areas.map((a) => Math.abs(a / mean - 1))),
    tallest: Math.max(...heights) / Math.min(...heights),
  }
}

const ar = (item) => (item?.w && item?.h ? item.w / item.h : 4 / 3)

/** Every way of cutting `n` things into `k + 1` runs. */
function eachCut(n, k, visit) {
  const cuts = []
  const walk = (start, left) => {
    if (!left) return visit(cuts)
    for (let i = start; i <= n - left; i++) {
      cuts.push(i)
      walk(i + 1, left - 1)
      cuts.pop()
    }
  }
  walk(1, k)
}

const shuffled = (list) => {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * The best arrangement of these pictures on this screen.
 *
 * Which pictures share a row decides everything — the row's height, and so every area in it —
 * so the search runs over orderings as well as over where to cut them. A few dozen orderings
 * against every possible set of cuts is a few thousand arrangements, scored in under a
 * millisecond, and it is the difference between a wall that fills nine tenths of the screen and
 * one that fills half of it.
 */
function layout(items, W, H, gap) {
  const started = performance.now()
  let best = null
  for (let attempt = 0; attempt < 200; attempt++) {
    // A hard stop rather than a fixed budget: this runs once when a screen wakes up and again
    // on a resize, and a wall that takes a noticeable moment to appear is worse than one that
    // gives up a percent of coverage.
    if (attempt > 20 && performance.now() - started > 60) break
    const order = attempt === 0 ? items : shuffled(items)
    // Up to eight rows: a tall screen holding wide pictures needs more of them, and stopping at
    // six was most of why a portrait monitor came out a third empty.
    for (let rows = 2; rows <= Math.min(8, order.length); rows++) {
      eachCut(order.length, rows - 1, (cuts) => {
        const tried = fitRows(order, cuts, W, H, gap)
        if (!tried) return
        const score =
          (1 - tried.covered) * WALL.weightFill +
          Math.max(0, tried.spread - WALL.sizeJitter) * WALL.weightEven +
          Math.max(0, tried.tallest - 2) * 0.6
        if (!best || score < best.score) best = { ...tried, score }
      })
    }
  }
  // Nothing fitted — one very wide picture, or a screen shaped like a letterbox. One row, and
  // let it be small rather than showing nothing.
  return best ?? fitRows(items, [], W, H, gap) ?? { rows: [items], heights: [H], covered: 0 }
}

/** Turn the chosen rows into a rectangle per picture, each row centred in the width. */
function placeRows(plan, W, H, gap, pad) {
  const out = []
  let y = pad
  plan.rows.forEach((row, i) => {
    const h = plan.heights[i]
    const width = row.reduce((sum, it) => sum + ar(it) * h, 0) + (row.length - 1) * gap
    let x = pad + (W - width) / 2
    for (const item of row) {
      const w = ar(item) * h
      out.push({ item, x, y, w, h })
      x += w + gap
    }
    y += h + gap
  })
  return out
}

// ── state ───────────────────────────────────────────────────────────────────

let me = null // { id, slot } — who this screen is, as far as the server is concerned
let tiles = [] // one per slot on the wall, in DOM order
let held = [] // { kind, item } — what this screen is holding, in the order it was dealt
let archive = [] // the curated pictures this screen has been given
let community = [] // the visitors' pictures, newest first
let rotateTimer = 0

/**
 * How many of this screen's pictures should be visitors' own.
 *
 * Ten and a quarter share is two and a half pictures, which is not a number of pictures, so it
 * rounds up: three of ten. Erring towards the visitors rather than away from them is the point
 * of the exhibit. Turn `communityShare` — or `tiles`, if you want the share to land exactly.
 */
const communityCount = () => Math.max(1, Math.round(WALL.tiles * WALL.communityShare))

/** ...and how many are actually available to fill them, which early in the day is fewer. */
const communityAvailable = () => Math.min(communityCount(), community.length)

// ── joining the wall ────────────────────────────────────────────────────────

async function join() {
  // The visitors' pictures first. How many exist decides how many curated ones to ask for, and
  // asking before knowing left the wall short: on a morning with nothing shared yet it reserved
  // three slots for pictures that did not exist and hung seven pictures instead of ten.
  community = await list()
  await claim(WALL.tiles - communityAvailable())

  build()
  setInterval(beat, WALL.beat)
  scheduleRotate()
}

/** Take `want` curated pictures from the allocator, replacing whatever this screen held. */
async function claim(want) {
  try {
    const res = await fetch(`${API}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ want: Math.max(0, want) }),
    })
    if (!res.ok) throw new Error(`${res.status}`)
    const body = await res.json()
    me = { id: body.id, slot: body.slot }
    archive = body.images ?? []
  } catch (err) {
    // No allocator: still show something rather than a black screen. Without the register this
    // screen may duplicate its neighbours, which is worse than a wall and better than nothing.
    me = null
    archive = []
    say(`no allocator (${err.message}) — this screen may repeat its neighbours`)
  }
}

async function beat() {
  if (!me) return
  try {
    const res = await fetch(`${API}/beat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: me.id }),
    })
    // The server forgot us — it restarted, or we were away too long. Take a fresh hand.
    if (res.status === 404) location.reload()
  } catch {
    /* the wall keeps showing what it has */
  }
}

// Give the pictures back on the way out, rather than making the server wait them out.
addEventListener('pagehide', () => {
  if (!me) return
  navigator.sendBeacon?.(`${API}/leave`, new Blob([JSON.stringify({ id: me.id })], { type: 'application/json' }))
})

// ── building the wall ───────────────────────────────────────────────────────

function build() {
  grid.style.setProperty('--gap', `${WALL.gap}px`)

  // The whole hand this screen is holding: the curated pictures, and the visitors' pictures
  // dealt in among them so they are scattered through the wall rather than blocked in a corner.
  const want = communityAvailable()
  const hand = []
  let c = 0
  let a = 0
  const every = Math.max(1, Math.round(WALL.tiles / Math.max(1, want)))
  for (let i = 0; i < WALL.tiles; i++) {
    const mine = want > 0 && i % every === 0 && c < want
    const item = mine ? communityAt(c++) : (archive[a++] ?? null)
    if (item) hand.push({ kind: mine ? 'community' : 'archive', item })
  }

  held = hand
  place()
}

/**
 * Work out where everything goes, and put it there.
 *
 * Split from build() because a resize wants this and not the dealing: re-dealing on a resize
 * would shuffle the whole wall for a window drag. The order is kept and only re-fitted.
 */
function place() {
  const pad = WALL.gap / 2
  const W = window.innerWidth - WALL.gap
  const H = window.innerHeight - WALL.gap
  const plan = layout(held.map((h) => h.item), W, H, WALL.gap)

  // `layout` reorders; follow it back to which picture is whose.
  const order = plan.rows.flat()
  const rects = placeRows(plan, W, H, WALL.gap, pad)
  const kindOf = new Map(held.map((h) => [h.item, h.kind]))

  tiles = rects.map((r, i) => makeTile(kindOf.get(order[i]) ?? 'archive', order[i], r))
  grid.replaceChildren(...tiles.map((t) => t.root))
  empty.hidden = tiles.some((t) => t.item)
}

/**
 * The visitor's picture this screen should show in its nth community slot.
 *
 * Slot 0 is always the newest, on every screen — a visitor who has just shared is being told to
 * go and look, and finding it should not depend on which of four monitors they walk to. The
 * rest stride by the number of screens, so beyond the newest no two screens agree.
 */
function communityAt(n) {
  if (!community.length) return null
  if (n === 0) return community[0]
  const screens = 4
  return community[1 + (me?.slot ?? 0) + (n - 1) * screens] ?? community[n % community.length] ?? null
}

function makeTile(kind, item, rect) {
  const root = document.createElement('figure')
  root.className = `tile tile-${kind}`
  root.style.left = `${rect.x}px`
  root.style.top = `${rect.y}px`
  root.style.width = `${rect.w}px`
  root.style.height = `${rect.h}px`

  const tile = { root, kind, item, rect, front: null, back: null, meta: null }
  const front = layer()
  const back = layer()
  root.append(back, front)
  tile.front = front
  tile.back = back

  if (kind === 'community') {
    tile.meta = document.createElement('figcaption')
    tile.meta.className = 'tile-meta'
    root.append(tile.meta)
  }

  if (item) show(tile, item, { instant: true })
  return tile
}

const layer = () => {
  const img = document.createElement('img')
  img.className = 'layer'
  img.alt = ''
  img.decoding = 'async'
  return img
}

/**
 * Put a picture into a tile, crossfading over whatever was there.
 *
 * Two stacked images and a swap of which is on top: the outgoing one is never removed until the
 * incoming one has actually decoded, so a slow picture leaves a picture on the wall rather than
 * a hole. The tile keeps its footprint through the change — re-shaping it would reflow the whole
 * wall for one tile, and every other picture would twitch.
 */
async function show(tile, item, { instant = false, fresh = false } = {}) {
  tile.item = item
  if (!item) return

  const next = tile.back
  next.src = item.src ?? item.image
  try {
    await next.decode()
  } catch {
    /* a picture that will not decode still gets its turn; it just shows nothing */
  }

  next.style.transitionDuration = instant ? '0ms' : `${WALL.fade}ms`
  tile.front.style.transitionDuration = instant ? '0ms' : `${WALL.fade}ms`
  next.classList.add('on')
  tile.front.classList.remove('on')
  ;[tile.front, tile.back] = [next, tile.front]

  if (tile.meta) drawMeta(tile, item)
  if (fresh) {
    tile.root.classList.remove('fresh')
    void tile.root.offsetWidth // restart the animation rather than letting it be a no-op
    tile.root.classList.add('fresh')
  }
}

/**
 * The two things worth keeping about a visitor's picture: the colours they gave each channel,
 * and when. No names and no captions — the wall is pictures.
 */
function drawMeta(tile, item) {
  const hues = item.shownHue ?? CHANNELS.map((ch) => ch.hue)
  tile.meta.replaceChildren(
    ...hues.map((deg) => {
      const dot = document.createElement('i')
      dot.style.background = `hsl(${deg}, 100%, 50%)`
      return dot
    }),
    Object.assign(document.createElement('span'), { textContent: ago(item.ts) })
  )
}

// ── the slow drift ──────────────────────────────────────────────────────────

function scheduleRotate() {
  clearTimeout(rotateTimer)
  rotateTimer = setTimeout(rotate, WALL.rotateEvery)
}

/**
 * Change one curated tile. One, not all of them: a wall where everything dissolves at once is a
 * slideshow, and a slideshow in the corner of your eye is a distraction. One tile turning over
 * every half minute reads as a room that is alive.
 */
async function rotate() {
  const pool = tiles.filter((t) => t.kind === 'archive' && t.item)
  const tile = pool[Math.floor(Math.random() * pool.length)]
  if (tile && me) {
    try {
      const res = await fetch(`${API}/swap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Ask for the same proportions back. Every picture is shown at its own shape and
        // nothing is cropped, so a replacement of a different shape would move its whole row.
        body: JSON.stringify({ id: me.id, retire: tile.item.file, ar: tile.item.w / tile.item.h }),
      })
      const { image } = await res.json()
      if (image) await show(tile, image)
    } catch {
      /* keep what is on the wall */
    }
  }
  scheduleRotate()
}

// ── a visitor shares something ──────────────────────────────────────────────

/**
 * The newest picture takes the oldest community tile, and arrives lit.
 *
 * Not a rebuild: the wall must not flinch when somebody shares. One tile changes, and the light
 * on it is how the person who just made it finds it from across the room.
 */
async function onPublished(items) {
  const had = community[0]?.id
  community = items
  if (!community.length || community[0]?.id === had) return

  const slots = tiles.filter((t) => t.kind === 'community')

  // The wall is still filling up — it is holding fewer of the visitors' pictures than its share,
  // because there were not that many when it woke up. Take back a curated picture and re-deal.
  //
  // Only ever the first few of the day. After that the share is met and the branch below runs
  // instead, which changes one tile and leaves the layout alone. It has to work this way round:
  // every visitor's picture is the same shape as every other, so once a slot of that shape
  // exists the next one drops straight into it — but making the *first* one needs a slot that
  // is not there yet, and nothing is cropped to force it.
  if (slots.length < communityAvailable()) {
    await claim(WALL.tiles - communityAvailable())
    build()
    const arrived = tiles.find((t) => t.kind === 'community' && t.item?.id === community[0]?.id)
    if (arrived) {
      arrived.root.classList.remove('fresh')
      void arrived.root.offsetWidth
      arrived.root.classList.add('fresh')
    }
    empty.hidden = true
    return
  }

  if (!slots.length) return

  const oldest = slots.reduce((a, b) => ((a.item?.ts ?? 0) <= (b.item?.ts ?? 0) ? a : b))
  slots.forEach((t) => t.root.classList.remove('fresh'))
  await show(oldest, community[0], { fresh: true })

  // The others shuffle down quietly, so this screen's stride through the list stays true.
  let n = 1
  for (const t of slots) {
    if (t === oldest) continue
    await show(t, communityAt(n++))
  }
  empty.hidden = true
}

// ── fitting the screen ──────────────────────────────────────────────────────

/**
 * Size the grid square so the whole wall lands inside the monitor.
 *
 * Measured from what the browser actually packed rather than from the areas we asked for:
 * `grid-auto-flow: dense` leaves holes we cannot predict, and a wall that is one row too tall
 * on a screen with no scrollbar simply loses its bottom row.
 */
// A resize re-fits the same pictures in the same order — it does not deal a new hand, which
// would shuffle the whole wall for a window drag. Debounced, because the search is a few
// thousand arrangements and a drag is a few hundred resize events.
let refit = 0
addEventListener('resize', () => {
  clearTimeout(refit)
  refit = setTimeout(() => held.length && place(), 250)
})

function ago(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (!Number.isFinite(mins) || mins < 1) return 'just now'
  if (mins < 60) return `${mins} min`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours} hr` : `${Math.floor(hours / 24)} d`
}

function say(message) {
  empty.hidden = false
  empty.replaceChildren(
    'Gallery wall',
    Object.assign(document.createElement('small'), {
      className: 'wall-note',
      textContent: `${location.origin} · ${message}`,
    })
  )
}

subscribe(onPublished)
join()

// The timestamps age on a wall that sits untouched for hours.
setInterval(() => tiles.forEach((t) => t.meta && t.item && drawMeta(t, t.item)), 60000)
