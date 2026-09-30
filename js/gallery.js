// The gallery wall — one screen of four. The anchored pile.
//
// Pictures are large, and each one lands on one of six places: three down the left half of the
// screen and three down the right. They alternate sides, so the two newest are always one on
// each side, and they land over whatever is already there, so the wall reads as a pile of prints
// building up rather than a slideshow. A side never uses the same place twice running: all three
// are used before any comes round again, so each picture overlaps the ones under it instead of
// hiding the last one exactly. A small nudge and tilt keep the pile from looking ruled.
//
// Only a handful are kept. The wall screens are Raspberry Pi 3s with a gigabyte, and every print
// on the wall holds its whole decoded picture, covered or not.
//
// Joining the wall and holding pictures nobody else has is in js/wallscreen.js, apart from the
// layout, because that half is the server's protocol rather than a design choice.

import { CHANNELS } from './imaging.js'
import { list, subscribe } from './store.js'
import { joinWall } from './wallscreen.js'

// ── the knobs ───────────────────────────────────────────────────────────────

const WALL = {
  /**
   * Where a print lands: its centre, as fractions of the screen. Three down each half. The
   * columns sit in from the middle of each half so a large print still mostly fits on screen.
   */
  anchors: {
    left: [
      { x: 0.27, y: 0.27 },
      { x: 0.27, y: 0.5 },
      { x: 0.27, y: 0.73 },
    ],
    right: [
      { x: 0.73, y: 0.27 },
      { x: 0.73, y: 0.5 },
      { x: 0.73, y: 0.73 },
    ],
  },

  /** The box a print is fitted into, at its own proportions, as fractions of the screen. */
  size: { w: 0.46, h: 0.66 },

  /** How far a print may land off its anchor, as a fraction of the screen, and how far it tilts. */
  jitter: 0.03,
  tilt: 3,

  /** Prints kept on the wall. The oldest goes when a new one would make one more than this. */
  keep: 6,

  /** A picture is laid down this often. */
  addEvery: 30000,

  /** ...and this fraction of everything on the wall should be visitors' own. */
  communityShare: 0.25,

  /** The black mount around every print, in pixels. */
  border: 9,

  /** How long a print takes to turn into place. */
  spin: 1000,
}

const wall = document.getElementById('wall')
const empty = document.getElementById('empty')

// Nothing on this page reloads it. A reload is a full page rebuilt from nothing — every picture
// fetched and decoded again, on a Pi 3 already short of power — and one that cannot reach the
// server is a browser error page that never retries. If the server forgets this screen,
// wallscreen.js signs it back in on the next beat instead.
const screen = joinWall({
  onTrouble: (err) => say(`no allocator (${err.message}) — this screen may repeat its neighbours`),
})

let prints = [] // { print, item, kind, side, anchor, nudge, tilt, z } — oldest first
let pool = [] // curated pictures this screen holds and has not laid down yet
let community = [] // the visitors' pictures, newest first
let shown = new Set() // ids of visitors' pictures already on this wall
let laid = { total: 0, community: 0 } // what is on the wall now, for keeping the share
let newest = null // the visitor's picture wearing the outline: the latest one shared
let nextSide = Math.random() < 0.5 ? 'left' : 'right'
let stacking = 0 // the z-order: every print lands above everything before it

// ── where the next one lands ────────────────────────────────────────────────

/** The numbers 0..n-1, in some order. */
function shuffled(n) {
  const out = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// A bag of places per side, drawn without replacement and refilled when empty. That is what
// keeps a side off the place it just used: all three come up before any comes up again. The
// refill is also kept from starting with the place the last bag ended on, which a plain shuffle
// would do one time in three.
const bags = { left: [], right: [] }
const lastOf = { left: -1, right: -1 }

function drawAnchor(side) {
  if (!bags[side].length) {
    let order = shuffled(WALL.anchors[side].length)
    if (order.length > 1 && order[0] === lastOf[side]) order = [...order.slice(1), order[0]]
    bags[side] = order
  }
  const at = bags[side].shift()
  lastOf[side] = at
  return at
}

/** A print's box on screen: fitted into the size box at its own shape, centred on its anchor. */
function placeOf(entry) {
  const W = window.innerWidth
  const H = window.innerHeight
  const ar = entry.item.ar || (entry.item.w && entry.item.h ? entry.item.w / entry.item.h : 4 / 3)
  const boxW = W * WALL.size.w
  const boxH = H * WALL.size.h
  const w = Math.min(boxW, boxH * ar)
  const h = w / ar
  const a = WALL.anchors[entry.side][entry.anchor]
  const cx = a.x * W + entry.nudge.x * W
  const cy = a.y * H + entry.nudge.y * H
  // Kept on screen. A print hanging off the edge is a print half of which nobody sees, and the
  // anchors near the top and bottom would otherwise push the tall ones out.
  const x = Math.min(Math.max(cx - w / 2, 0), W - w)
  const y = Math.min(Math.max(cy - h / 2, 0), H - h)
  return { x, y, w, h }
}

// ── laying a picture down ───────────────────────────────────────────────────

/**
 * Put one picture on the wall, turning as it lands, on the next side and a fresh place on it.
 * The oldest print goes once there are more than `keep`.
 */
function lay(item, kind) {
  if (!item) return null
  const side = nextSide
  nextSide = side === 'left' ? 'right' : 'left'

  const print = document.createElement('figure')
  print.className = `print print-${kind}`
  const img = document.createElement('img')
  img.alt = ''
  img.decoding = 'async'
  img.src = item.src ?? item.image
  print.append(img)
  if (kind === 'community') print.append(caption(item))

  const rand = () => (Math.random() * 2 - 1)
  const entry = {
    print,
    item,
    kind,
    side,
    anchor: drawAnchor(side),
    nudge: { x: rand() * WALL.jitter, y: rand() * WALL.jitter },
    tilt: rand() * WALL.tilt,
    z: ++stacking,
  }
  // Readable in the inspector: which side and which of its places, e.g. "left 2".
  print.dataset.place = `${side} ${entry.anchor}`
  wall.append(print)
  prints.push(entry)
  settle(entry)

  laid.total++
  if (kind === 'community') {
    laid.community++
    shown.add(item.id)
  }
  empty.hidden = true

  spin(entry, { from: entry.tilt - 14, scale: 0.72 })
  trim()
  return entry
}

/** Take the oldest prints off. */
function trim() {
  const handBack = []
  while (prints.length > WALL.keep) {
    const gone = prints.shift()
    if (gone === newest) newest = null
    gone.spinning?.cancel()
    gone.print.remove()
    laid.total--
    if (gone.kind === 'community') laid.community--
    else if (gone.item?.file) handBack.push(gone.item.file)
  }
  // Scrolled off; somebody else may as well have them.
  screen.release(handBack)
}

/** Where a print sits, how large and which way up. One transform, so nothing reflows. */
function settle(entry) {
  const { print } = entry
  const r = placeOf(entry)
  entry.rect = r
  print.style.width = `${r.w}px`
  print.style.height = `${r.h}px`
  print.style.zIndex = String(entry.z)
  print.style.transform = `translate(${r.x}px, ${r.y}px) rotate(${entry.tilt}deg)`
}

/** The one gesture the wall has: a print turns into place. */
function spin(entry, { from, scale }) {
  const { rect, tilt } = entry
  const put = (deg, s) => `translate(${rect.x}px, ${rect.y}px) rotate(${deg}deg) scale(${s})`
  entry.spinning?.cancel()
  const anim = entry.print.animate(
    [
      { transform: put(from, scale), opacity: 0 },
      { transform: put(tilt + (tilt - from) * 0.12, 1.04), opacity: 1, offset: 0.74 },
      { transform: put(tilt, 1), opacity: 1 },
    ],
    {
      duration: entry === newest ? WALL.spin * 1.5 : WALL.spin,
      easing: 'cubic-bezier(.2, .84, .25, 1)',
      fill: 'both',
    }
  )
  entry.spinning = anim

  // Let go once it has landed. A finished animation with fill:both keeps painting its last
  // keyframe, and an animation effect outranks inline style — so a print that had spun in
  // would ignore a resize. `settle()` has already written the same resting transform inline,
  // so cancelling changes nothing on screen; it only hands control back.
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
 * Mark a visitor's new picture, and bring it in with a bigger turn.
 *
 * It is not held on top. It was, for five minutes, and that meant every picture laid in that
 * time slid in *under* it — and after every reload an old visitor's picture was the one held
 * there, so for five minutes an hour the whole wall was landing underneath somebody's photo
 * from the day before. Every print now lands on top of everything before it, this one
 * included; it is simply the newest when it arrives, and the pile covers it like any other.
 */
function crown(entry) {
  if (!entry) return
  if (newest && newest !== entry) newest.print.classList.remove('newest')
  newest = entry
  entry.print.classList.add('newest')
  spin(entry, { from: entry.tilt - 380, scale: 0.4 })
}

// ── what goes up next ───────────────────────────────────────────────────────

/**
 * A visitor's picture if the wall owes them one, otherwise a curated one.
 *
 * The share is counted over what is on the wall now: prints are taken off, and the counts with
 * them, so the ratio is the ratio on screen.
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
  return owed ? { item: unseen(), kind: 'community' } : null
}

async function tick() {
  const up = nextUp()
  if (up) lay(up.item, up.kind)
  // Keep a few in hand, so the timer never waits on the network.
  if (pool.length < 3) pool.push(...(await screen.claim(WALL.keep)))
  setTimeout(tick, WALL.addEvery)
}

// ── a visitor shares something ──────────────────────────────────────────────

/**
 * Straight onto the wall, ahead of the timer: the person who made it is walking over to look.
 *
 * The share is not rebalanced here the way the grid wall did it, by laying curated pictures down
 * straight after to dilute it. With six on the wall that buried the very picture it was for.
 * The timer pulls the share back one picture at a time instead.
 */
function onPublished(items) {
  const was = community[0]?.id
  community = items
  if (!community.length || community[0]?.id === was) return
  crown(lay(community[0], 'community'))
}

// ── waking up ───────────────────────────────────────────────────────────────

async function start() {
  wall.style.setProperty('--border', `${WALL.border}px`)
  community = await list()
  pool = await screen.claim(WALL.keep)

  // A wall should look like a wall the moment it is switched on, not fill up over three
  // minutes: the first few go down at once, a beat apart so they read as landing, not appearing.
  let last = null
  for (let i = 0; i < WALL.keep; i++) {
    const up = nextUp()
    if (!up) break
    const entry = lay(up.item, up.kind)
    if (entry?.kind === 'community') last = entry
    await new Promise((done) => setTimeout(done, 260))
  }
  if (last) crown(last)
  if (!laid.total) say('nothing to show yet')

  setTimeout(tick, WALL.addEvery)
}

// Everything is measured in pixels, so a resize needs new boxes. Each print keeps its side, its
// place and its nudge; only the pixels change.
let refit = 0
addEventListener('resize', () => {
  clearTimeout(refit)
  refit = setTimeout(() => prints.forEach(settle), 250)
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
