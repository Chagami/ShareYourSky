// The gallery wall — one screen of four. The stacking design.
//
// Nothing ever leaves. Pictures are laid down one at a time into a grid of black-bordered
// prints; when that grid is full a new one begins, shifted a little, and the pile grows over it.
// The grids underneath stay and show at their edges, so the wall reads as an evening's worth of
// pictures accumulating rather than a slideshow rotating through them.
//
// Joining the wall and holding pictures nobody else has is in js/wallscreen.js, apart from the
// layout, because that half is the server's protocol rather than a design choice.

import { CHANNELS } from './imaging.js'
import { list, subscribe } from './store.js'
import { joinWall } from './wallscreen.js'

// ── the knobs ───────────────────────────────────────────────────────────────

const WALL = {
  /** Prints in one grid. When it is full, a new grid starts on top of it. */
  tiles: 10,

  /** How many grids to keep. Below that they are entirely covered anyway, and dropped. */
  layers: 4,

  /** How far each grid leans from the one under it, as a fraction of the smaller screen edge. */
  offset: 0.03,

  /** A picture is laid down this often. */
  addEvery: 30000,

  /** ...and this fraction of everything on the wall should be visitors' own. */
  communityShare: 0.25,

  /** The black mount around every print, in pixels. */
  border: 9,

  /**
   * How much larger the biggest print in a grid is than the smallest. Exactly this, every grid —
   * not an average of it — and which place gets which size is drawn afresh each time, so the
   * biggest picture on the wall keeps moving.
   */
  sizeRange: 2,

  /** The newest visitor's picture, against the largest of the other visitors' pictures. */
  freshScale: 1.5,

  /** How long a print takes to turn into place. */
  spin: 1000,
}

const wall = document.getElementById('wall')
const empty = document.getElementById('empty')

const screen = joinWall({
  onLost: () => location.reload(),
  onTrouble: (err) => say(`no allocator (${err.message}) — this screen may repeat its neighbours`),
})

let layers = [] // { el, slots, next } — oldest first, newest last and on top
let pool = [] // curated pictures this screen holds and has not laid down yet
let community = [] // the visitors' pictures, newest first
let shown = new Set() // ids of visitors' pictures already on this wall
let laid = { total: 0, community: 0 } // what has actually gone up, for keeping the share
let newest = null // the print wearing the extra size

// ── the grid a layer is laid out on ─────────────────────────────────────────

const lean = () => WALL.offset * Math.min(window.innerWidth, window.innerHeight)

/**
 * A size for every place in a grid.
 *
 * The largest is exactly `sizeRange` times the smallest — pinned, not sampled, because drawing
 * `n` numbers out of a range gives a spread of whatever it happens to give and the wall came out
 * looking uniform. One place is dealt the floor and another the ceiling, and the rest fall
 * between; both are drawn again for every grid, so the biggest picture is never in the same
 * corner twice.
 *
 * Then normalised on *area* rather than on width, so a grid of mixed sizes covers about as much
 * wall as a grid of equal ones. Normalising on width would have grown the total by half.
 */
function spreadSizes(n) {
  const raw = Array.from({ length: n }, () => 1 + Math.random() * (WALL.sizeRange - 1))
  if (n > 1) {
    const small = Math.floor(Math.random() * n)
    let large = Math.floor(Math.random() * (n - 1))
    if (large >= small) large++
    raw[small] = 1
    raw[large] = WALL.sizeRange
  }
  const meanArea = raw.reduce((sum, v) => sum + v * v, 0) / n
  const k = 1 / Math.sqrt(meanArea)
  return raw.map((v) => v * k)
}

/** The numbers 0..n-1, in some order. */
function shuffled(n) {
  const out = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Slot rectangles for the grid at a given depth.
 *
 * Cells are uniform and every print sits inside one at its own proportions, so nothing is
 * cropped and the grid still reads as a grid. The column count is chosen to bring a cell's shape
 * near the pictures' own — a landscape photograph in a tall cell is mostly black mount.
 */
function slotsFor(depth) {
  const room = lean() * (WALL.layers - 1)
  const boxW = window.innerWidth - room
  const boxH = window.innerHeight - room

  let best = null
  for (let cols = 1; cols <= WALL.tiles; cols++) {
    const rows = Math.ceil(WALL.tiles / cols)
    const cell = boxW / cols / (boxH / rows)
    // Near the shape of the pictures, and not wasting many cells on a ragged last row.
    const score = Math.abs(Math.log(cell / 1.4)) + (cols * rows - WALL.tiles) * 0.12
    if (!best || score < best.score) best = { cols, rows, score }
  }

  const cw = boxW / best.cols
  const ch = boxH / best.rows
  const shift = depth * lean()
  return Array.from({ length: WALL.tiles }, (_, i) => ({
    x: shift + (i % best.cols) * cw,
    y: shift + Math.floor(i / best.cols) * ch,
    w: cw,
    h: ch,
  }))
}

/**
 * Start a new grid over the last one, and drop any that have fallen off the back.
 *
 * The grid's places are all decided the moment it is made — but the order they get filled in is
 * shuffled, so pictures appear about the grid rather than marching along it. A wall filling left
 * to right reads as a progress bar; one filling at random reads as a wall.
 */
function newLayer() {
  const el = document.createElement('div')
  el.className = 'layer'
  wall.append(el)
  layers.push({
    el,
    slots: [],
    order: shuffled(WALL.tiles),
    sizes: spreadSizes(WALL.tiles),
    next: 0,
    prints: [],
  })

  // A wall that runs for twelve hours would otherwise be holding a thousand pictures, all but
  // forty of them completely covered.
  while (layers.length > WALL.layers) {
    const gone = layers.shift()
    gone.el.remove()
    // Take its prints off the count as well. The share is a fact about what is on the wall, and
    // counting pictures that have been dropped made a wall that had run its ratio up unable to
    // pull it back down — every curated picture it added was cancelled out by a ghost.
    const handBack = []
    for (const entry of gone.prints) {
      laid.total--
      if (entry.kind === 'community') laid.community--
      else if (entry.item?.file) handBack.push(entry.item.file)
      if (entry === newest) newest = null
    }
    screen.release(handBack)
  }

  // Re-lean everything, so the stack always runs from the back of the screen to the front.
  relean()
  return layers[layers.length - 1]
}

function relean() {
  layers.forEach((layer, depth) => {
    layer.slots = slotsFor(depth)
    layer.el.style.zIndex = String(depth)
    // By the place each print took, not by the order it was hung. They are no longer the same
    // thing — the grid fills at random — and matching them up by position would deal every
    // picture a different spot every time the stack re-leans or the window changes size.
    layer.prints.forEach((entry) => {
      const rect = layer.slots[entry.slotIndex]
      if (!rect) return
      entry.rect = rect
      settle(entry)
    })
  })
}

// ── laying a picture down ───────────────────────────────────────────────────

/**
 * Put one picture on the wall, turning as it lands.
 *
 * Into the top grid's next free slot; when that grid is full a new one starts over it. Nothing
 * is taken away to make room — the whole point of this design is that the evening accumulates.
 */
function lay(item, kind) {
  if (!item) return null
  let layer = layers[layers.length - 1]
  if (!layer || layer.next >= WALL.tiles) layer = newLayer()

  // Which place in the grid this one takes. The places were fixed when the grid was made; the
  // order they are handed out in was shuffled with it.
  const slotIndex = layer.order[layer.next++]
  const rect = layer.slots[slotIndex]
  const print = document.createElement('figure')
  print.className = `print print-${kind}`

  const img = document.createElement('img')
  img.alt = ''
  img.decoding = 'async'
  img.src = item.src ?? item.image
  print.append(img)
  if (kind === 'community') print.append(caption(item))

  const entry = { print, item, kind, rect, slotIndex, scale: layer.sizes[slotIndex], big: false }
  layer.el.append(print)
  layer.prints.push(entry)
  settle(entry)

  laid.total++
  if (kind === 'community') {
    laid.community++
    shown.add(item.id)
  }
  empty.hidden = true

  spin(entry, { from: -14, scale: entry.scale * 0.72 })
  return entry
}

/** Where a print sits and how large. Position and size are one transform, so neither reflows. */
/** How large this print is drawn: its own size, unless it is the newest. */
const sizeOf = (entry) => (entry.big ? entry.crownScale : entry.scale)

function settle(entry) {
  const { print, rect } = entry
  print.style.width = `${rect.w}px`
  print.style.height = `${rect.h}px`
  print.style.transform = `translate(${rect.x}px, ${rect.y}px) scale(${sizeOf(entry)})`
}

/** The one gesture the wall has: a print turns into place. */
function spin(entry, { from, scale }) {
  const { rect } = entry
  const to = sizeOf(entry)
  const put = (deg, s) => `translate(${rect.x}px, ${rect.y}px) rotate(${deg}deg) scale(${s})`
  entry.spinning?.cancel()
  const anim = entry.print.animate(
    [
      { transform: put(from, scale), opacity: 0 },
      { transform: put(from * -0.12, to * 1.05), opacity: 1, offset: 0.74 },
      { transform: put(0, to), opacity: 1 },
    ],
    {
      duration: entry.big ? WALL.spin * 1.5 : WALL.spin,
      easing: 'cubic-bezier(.2, .84, .25, 1)',
      fill: 'both',
    }
  )
  entry.spinning = anim

  // Let go once it has landed. A finished animation with fill:both keeps painting its last
  // keyframe, and an animation effect outranks inline style — so a print that had spun in
  // simply ignored being re-leaned, and the stack stopped stepping back to front. `settle()`
  // has already written the same resting transform inline, so cancelling changes nothing on
  // screen; it only hands control back.
  anim.finished.then(
    () => {
      if (entry.spinning === anim) {
        anim.cancel()
        entry.spinning = null
        settle(entry)
      }
    },
    () => {}
  )
}

function caption(item) {
  const cap = document.createElement('figcaption')
  const hues = item.shownHue ?? CHANNELS.map((ch) => ch.hue)
  cap.append(
    ...hues.map((deg) => {
      const dot = document.createElement('i')
      dot.style.background = `hsl(${deg}, 100%, 50%)`
      return dot
    }),
    Object.assign(document.createElement('span'), { className: 'when', textContent: ago(item.ts) })
  )
  cap.dataset.ts = item.ts
  return cap
}

// ── the newest visitor's picture ────────────────────────────────────────────

/**
 * Half again as large as the other visitors' pictures, and it turns further coming in.
 *
 * Larger by transform rather than by taking a bigger slot, so the grid underneath is untouched
 * and it simply overlaps its neighbours — which, on a wall of stacked prints, is what being on
 * top of the pile looks like anyway.
 */
function crown(entry) {
  if (!entry || entry === newest) return
  if (newest) {
    newest.big = false
    newest.print.classList.remove('newest')
    settle(newest)
  }
  newest = entry
  entry.big = true
  // Half again the largest of the other visitors' pictures, not half again its own place — the
  // places are different sizes now, and landing in a small one must not make the newest picture
  // on the wall smaller than one somebody left twenty minutes ago.
  const others = layers
    .flatMap((l) => l.prints)
    .filter((e) => e.kind === 'community' && e !== entry)
    .map((e) => e.scale)
  entry.crownScale = WALL.freshScale * Math.max(entry.scale, ...others, 0)
  entry.print.classList.add('newest')
  settle(entry)
  spin(entry, { from: -380, scale: entry.crownScale * 0.4 })
}

// ── what goes up next ───────────────────────────────────────────────────────

/**
 * A visitor's picture if the wall owes them one, otherwise a curated one.
 *
 * The share is counted over everything ever laid down, which on this wall is the same as
 * everything on it: nothing is removed, so the running ratio *is* the ratio on screen.
 */
function nextUp() {
  const unseen = () => community.find((c) => !shown.has(c.id))
  const owed = laid.total === 0 || laid.community / laid.total < WALL.communityShare
  if (owed) {
    const mine = unseen()
    if (mine) return { item: mine, kind: 'community' }
  }
  const curated = pool.shift()
  if (curated) return { item: curated, kind: 'archive' }
  // Nothing curated in hand. Only fall back to a visitor's picture if the share can afford it —
  // otherwise a wall that has run hot keeps laying down the very thing it is trying to dilute.
  return owed ? { item: unseen(), kind: 'community' } : null
}

async function tick() {
  const up = nextUp()
  if (up) lay(up.item, up.kind)
  // Keep a few in hand, so the timer never waits on the network.
  if (pool.length < 3) pool.push(...(await screen.claim(WALL.tiles)))
  // And keep pulling the ratio back, so a rush that ran the share up recovers over the next
  // few minutes rather than leaving the wall lopsided until it is switched off.
  balance()
  setTimeout(tick, WALL.addEvery)
}

// ── a visitor shares something ──────────────────────────────────────────────

function onPublished(items) {
  const was = community[0]?.id
  community = items
  if (!community.length || community[0]?.id === was) return
  // Straight onto the wall, ahead of the timer: the person who made it is walking over to look.
  crown(lay(community[0], 'community'))
  balance()
}

/**
 * Put curated pictures up until the visitors' share is back where it should be.
 *
 * Every submission goes on the wall the moment it is made — that is the promise the exhibit
 * makes to the person who just pressed the button, and it is not negotiable against a ratio. So
 * the ratio is kept from the other side: a quarter share means three curated pictures for each
 * one of theirs, and a busy evening simply fills the wall faster.
 *
 * Without this a rush of visitors took the wall to two thirds theirs inside a minute.
 */
let balancing = false

async function balance() {
  // One at a time. A rush of visitors calls this once each, and four overlapping runs would
  // race each other through the same pool and lay down far more than the ratio asked for.
  if (balancing) return
  balancing = true
  try {
    let added = 0
    while (added < 8 && laid.total > 0 && laid.community / laid.total > WALL.communityShare) {
      if (!pool.length) {
        pool = await screen.claim(WALL.tiles)
        // Nothing to be had — an empty folder, or the allocator is down. Stop rather than spin.
        if (!pool.length) break
      }
      lay(pool.shift(), 'archive')
      added++
      // Staggered, so it reads as the wall filling in around the new picture rather than
      // several things appearing in the same frame.
      await new Promise((done) => setTimeout(done, 260))
    }
  } finally {
    balancing = false
  }
}

// ── waking up ───────────────────────────────────────────────────────────────

async function start() {
  wall.style.setProperty('--border', `${WALL.border}px`)
  community = await list()
  pool = await screen.claim(WALL.tiles)

  // A wall should look like a wall the moment it is switched on, not fill up over five minutes,
  // so the first grid goes down at once and the timer takes it from there.
  let last = null
  for (let i = 0; i < WALL.tiles; i++) {
    const up = nextUp()
    if (!up) break
    const entry = lay(up.item, up.kind)
    if (entry?.kind === 'community') last = entry
  }
  if (last) crown(last)
  if (!laid.total) say('nothing to show yet')

  setTimeout(tick, WALL.addEvery)
}

// Everything here is measured in pixels, so a resize needs new slots. What is on the wall keeps
// its picture and its order; only where it sits changes.
let refit = 0
addEventListener('resize', () => {
  clearTimeout(refit)
  refit = setTimeout(relean, 250)
})

// Timestamps age on a wall that sits untouched for hours.
setInterval(() => {
  for (const cap of wall.querySelectorAll('.print-community figcaption')) {
    const when = cap.querySelector('.when')
    if (when) when.textContent = ago(Number(cap.dataset.ts))
  }
}, 60000)

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
start()
