// Handing pictures out to the gallery screens.
//
// The wall is four monitors, each running its own copy of gallery.html, and the thing they must
// not do is show each other's pictures. None of them can know that alone, so the server keeps
// the register: who is live, what each is holding, and what nobody is holding.
//
//   POST api/gallery/join   { want }            join the wall, get `want` pictures nobody has
//   POST api/gallery/beat   { id }              still here — hold onto them
//   POST api/gallery/swap   { id, retire, ar }  give one back, take another of that shape
//   POST api/gallery/more   { id, want }        take more, without joining again
//   POST api/gallery/release{ id, files }       hand some back, still on the wall
//   POST api/gallery/leave  { id }              done, release everything
//   GET  api/gallery/state                      who is on the wall and what they hold
//   GET  api/gallery/img/<file>                 one of the curated pictures
//
// A screen that goes away without saying so — unplugged, crashed, closed — stops beating, and
// its pictures come back into circulation on their own. A museum wall runs unattended for
// twelve hours at a stretch; anything that needs a person to tidy it up will not get tidied.
//
// The filler images live in `img/sky/`. Curating the wall is dropping files into that folder —
// no script to run, no manifest to keep in step, no rebuild. The folder is the only source of
// truth, and this reads it: names, and each picture's dimensions out of its own header, because
// the screens need those to lay out before the pictures have loaded.
//
// It used to require a `manifest.json` written by the fetch script, which meant a folder full of
// images and no manifest showed a wall of black rectangles — the one thing anybody would do
// first. Any filename works too: they are served from an allowlist of what the scan found, so
// spaces, brackets and photographers' names in the filename are all fine.
//
// Served from here rather than from `public/`, which would copy every one of them into `dist/`
// on each build — and `dist/` is committed, so the exhibit would carry two copies of the lot.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { imageSizeOf } from './imagesize.js'

const IMAGE = /\.(jpe?g|png|webp)$/i

// How long a screen may go quiet before the wall assumes it is gone. Comfortably more than the
// client's heartbeat, so an ordinary hiccup does not shuffle a working screen's pictures.
const FORGET_AFTER = 45000

const TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

export function galleryAllocator({ dir = 'img/sky' } = {}) {
  let root = process.cwd()
  const screens = new Map()
  let cache = { at: 0, mtime: 0, items: [] }

  // How many times each picture has been handed out, ever. The tiebreak when there are more
  // slots on the wall than pictures to fill them: show the least-seen thing rather than the
  // first thing in the folder.
  const shown = new Map()

  // Dimensions, by filename. Reading a header is cheap but not free, and the folder is read
  // again on every join; keyed by size and mtime so a replaced file is re-read.
  const measured = new Map()

  /**
   * What is in the folder right now.
   *
   * Re-read whenever the folder's own timestamp changes, so pictures can be added or taken away
   * while the wall is running and the screens pick it up on their next swap.
   */
  function manifest() {
    const base = resolve(root, dir)
    if (!existsSync(base)) return []
    try {
      const mtime = statSync(base).mtimeMs
      if (mtime === cache.mtime) return cache.items

      const items = []
      for (const file of readdirSync(base)) {
        if (!IMAGE.test(file)) continue
        const path = resolve(base, file)
        let stat
        try {
          stat = statSync(path)
        } catch {
          continue
        }
        if (!stat.isFile()) continue

        const key = `${file}:${stat.size}:${stat.mtimeMs}`
        let size = measured.get(key)
        if (!size) {
          size = imageSizeOf(path)
          if (!size?.w || !size?.h) continue
          measured.set(key, size)
        }
        items.push({
          file,
          // Encoded, because these are curated by hand and come with spaces, brackets and
          // photographers' names in them.
          src: `api/gallery/img/${encodeURIComponent(file)}`,
          w: size.w,
          h: size.h,
          ar: size.w / size.h,
        })
      }
      cache = { mtime, items }
      return items
    } catch {
      return cache.items
    }
  }

  const live = () => {
    const now = Date.now()
    for (const [id, s] of screens) if (now - s.seen > FORGET_AFTER) screens.delete(id)
    return [...screens.values()]
  }

  /** Everything currently on some other screen. */
  function takenBy(exceptId) {
    const held = new Set()
    for (const s of live()) if (s.id !== exceptId) for (const f of s.holding) held.add(f)
    return held
  }

  /**
   * Choose `count` pictures for one screen.
   *
   * Nobody else's first, and among those the least-shown, so a wall that runs all day works
   * through the whole folder rather than orbiting the same dozen. Only when the wall wants more
   * pictures than exist does it start repeating — and then it repeats the rarest.
   */
  function allocate(id, count, avoid = new Set(), wantAr = 0) {
    const all = manifest()
    if (!all.length) return []
    const taken = takenBy(id)
    // `wantAr` is a swap asking for the same shape as the picture it is replacing. The wall lays
    // out at each picture's true proportions and crops nothing, so a tile that changed shape
    // would have to move every other tile with it — this keeps the layout still.
    const shapeOff = (e) => (wantAr ? Math.abs(Math.log(e.ar / wantAr)) * 30 : 0)
    const rank = (e) =>
      (taken.has(e.file) ? 1000 : 0) + (avoid.has(e.file) ? 500 : 0) + (shown.get(e.file) ?? 0) + shapeOff(e)

    const pool = all
      .map((e) => ({ e, key: rank(e) + Math.random() })) // random breaks ties, so screens differ
      .sort((a, b) => a.key - b.key)
      .slice(0, count)
      .map((x) => x.e)

    for (const e of pool) shown.set(e.file, (shown.get(e.file) ?? 0) + 1)
    return pool
  }

  const json = (res, code, body) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  function readBody(req) {
    return new Promise((ok) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        try {
          ok(JSON.parse(raw || '{}'))
        } catch {
          ok({})
        }
      })
      req.on('error', () => ok({}))
    })
  }

  async function handle(req, res, next) {
    const path = new URL(req.url, 'http://x').pathname.replace(/^\/+/, '')
    if (!path.startsWith('api/gallery')) return next()
    const rest = path.slice('api/gallery'.length).replace(/^\/+/, '')

    // ── one of the curated pictures ──
    if (rest.startsWith('img/')) {
      let name
      try {
        name = decodeURIComponent(rest.slice(4))
      } catch {
        return json(res, 400, { error: 'bad name' })
      }

      // An allowlist of what the scan actually found, not a pattern the name has to match. A
      // pattern rejected every hand-curated file in the folder — they have spaces and brackets
      // and photographers' names in them — and this is the stricter check anyway: `..` is not
      // the name of a picture in the folder, so it cannot be one of these.
      const known = manifest().find((e) => e.file === name)
      if (!known) return json(res, 404, { error: 'no such picture' })

      const file = resolve(root, dir, name)
      if (!file.startsWith(resolve(root, dir) + sep)) return json(res, 400, { error: 'bad name' })

      res.statusCode = 200
      res.setHeader('content-type', TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream')
      // The folder changes when somebody curates it, not while the wall is running. Keyed on the
      // name, so a *replaced* file wants a hard refresh on the wall — or a different name.
      res.setHeader('cache-control', 'public, max-age=3600')
      res.end(readFileSync(file))
      return
    }

    if (rest === 'state') {
      return json(res, 200, {
        pictures: manifest().length,
        screens: live().map((s) => ({ id: s.id, slot: s.slot, holding: [...s.holding], seen: s.seen })),
      })
    }

    const body = req.method === 'POST' ? await readBody(req) : {}

    if (rest === 'join') {
      const want = Math.max(1, Math.min(60, Number(body.want) || 8))
      const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      // The lowest slot number nobody is using. It is what lets each screen take a different
      // stride through the visitors' pictures without any of them having to negotiate.
      const used = new Set(live().map((s) => s.slot))
      let slot = 0
      while (used.has(slot)) slot++

      const screen = { id, slot, holding: new Set(), seen: Date.now() }
      screens.set(id, screen)
      const picked = allocate(id, want)
      for (const p of picked) screen.holding.add(p.file)

      return json(res, 201, {
        id,
        slot,
        screens: live().length,
        pictures: manifest().length,
        images: picked,
      })
    }

    const screen = screens.get(body.id)
    if (!screen) return json(res, 404, { error: 'no such screen — join again' })
    screen.seen = Date.now()

    if (rest === 'beat') return json(res, 200, { ok: true, screens: live().length })

    // More pictures for a screen already on the register. The stacking wall asks for these as it
    // lays pictures down; joining again for them would put a second screen on the register every
    // time, each holding a hand of its own, and a folder of thirty would be dry within minutes.
    if (rest === 'more') {
      const want = Math.max(1, Math.min(60, Number(body.want) || 1))
      const picked = allocate(screen.id, want, screen.holding)
      for (const e of picked) screen.holding.add(e.file)
      return json(res, 200, { images: picked })
    }

    // Handed back because they have scrolled off the wall. Without this a screen that never
    // replaces anything holds everything it has ever shown, and its neighbours starve.
    if (rest === 'release') {
      for (const file of body.files ?? []) screen.holding.delete(file)
      return json(res, 200, { holding: screen.holding.size })
    }

    if (rest === 'swap') {
      if (body.retire) screen.holding.delete(body.retire)
      // Avoid what this screen still holds as well as what everyone else does — a tile fading
      // into a picture already three tiles along is the one swap a viewer would notice.
      const [next2] = allocate(screen.id, 1, screen.holding, Number(body.ar) || 0)
      if (!next2) return json(res, 200, { image: null })
      screen.holding.add(next2.file)
      return json(res, 200, { image: next2 })
    }

    if (rest === 'leave') {
      screens.delete(screen.id)
      return json(res, 200, { ok: true })
    }

    return json(res, 404, { error: 'no such endpoint' })
  }

  const install = (server) => {
    server.middlewares.use((req, res, next) => handle(req, res, next))
  }

  return {
    name: 'share-your-sky-gallery',
    configResolved(config) {
      root = config.root
    },
    configureServer: install,
    configurePreviewServer: install,
  }
}
