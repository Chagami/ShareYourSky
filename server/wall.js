// The gallery wall's shared store, as a Vite middleware.
//
// The exhibit is two devices: the interaction runs on a tablet over the LAN, and the wall runs
// on a screen somewhere else. `localStorage` cannot span that — it is scoped to one origin in
// one browser, so `https://localhost:4173` and `https://192.168.1.20:4173` are two different
// walls served by the same machine, and two different machines are hopeless. Every picture the
// tablet made was being filed somewhere the wall could never look.
//
// So the pictures live on whichever machine serves the pages, and both screens talk to it:
//
//   GET    api/wall              the newest pictures, newest first
//   GET    api/wall?all=1        every picture ever shared, with sizes — for the admin page
//   POST   api/wall              publish one { image: dataURL, levels, shownHue }
//   GET    api/wall/stream       server-sent events; a new picture arrives as it is made
//   GET    api/wall/img/<id>.jpg the picture itself
//   DELETE api/wall/img/<id>     remove one picture, for good
//   DELETE api/wall              empty the wall (for whoever is running the exhibit)
//   GET    api/wall/zip          every picture, as one zip to download
//   POST   api/wall/zip          the pictures named in the form field `ids`, comma-separated
//
// Images are written as files rather than kept as base64 in a JSON blob. A data URL is a third
// larger than the bytes it carries, and twenty-four captures of it is more than the 5MB a
// browser will hold — which is why the old store quietly dropped the oldest pictures on a wall
// that claimed to show twenty-four.
//
// No authentication. This is a LAN exhibit with no route in from outside; adding a shared
// secret here would be a thing for a technician to lose, not a defence against anybody.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { imageSize, imageSizeOf } from './imagesize.js'

// How many the wall shows. Every picture ever shared stays on disk — this is a display choice,
// not a retention one, so a full day's visitors can be recovered from the folder afterwards.
const ON_THE_WALL = 24

// A generous ceiling on one upload. A 1400px JPEG data URL is well under a megabyte; this is
// only here so that a malformed request cannot make the exhibit machine read forever.
const MAX_UPLOAD = 12 * 1024 * 1024

/**
 * A picture's name for whoever downloads it: when it was shared, to the minute, and the start of
 * its id so two in the same minute do not collide. In the exhibit machine's own time.
 */
export function downloadName(entry) {
  const d = new Date(entry.ts)
  const p = (n) => String(n).padStart(2, '0')
  const when = Number.isFinite(d.getTime())
    ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
    : 'undated'
  return `share-your-sky-${when}-${entry.id.slice(0, 8)}.jpg`
}

// ── a zip, written by hand ──────────────────────────────────────────────────
//
// The pictures are JPEGs, which do not compress any further, so they go in "stored" — copied
// as they are — and a zip of stored files is simple enough to write without a library: a header
// before each file, a directory of them all at the end. Streamed, one picture at a time, so a
// season's worth never has to be in memory at once.

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** The date and time a zip entry carries, in the old MS-DOS form zips still use. */
function dosStamp(ts) {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now())
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

/** Write `files` ({ name, path, ts }) to `res` as a zip. Ones that have gone missing are skipped. */
function sendZip(res, zipName, files) {
  res.statusCode = 200
  res.setHeader('content-type', 'application/zip')
  res.setHeader('content-disposition', `attachment; filename="${zipName}"`)
  res.setHeader('cache-control', 'no-store')

  const central = []
  let offset = 0
  for (const file of files) {
    let bytes
    try {
      bytes = readFileSync(file.path)
    } catch {
      continue
    }
    const name = Buffer.from(file.name, 'utf8')
    const crc = crc32(bytes)
    const { time, date } = dosStamp(file.ts)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // names are UTF-8
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(bytes.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    res.write(local)
    res.write(name)
    res.write(bytes)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0) // central directory header
    entry.writeUInt16LE(20, 4) // made by
    entry.writeUInt16LE(20, 6) // version needed
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(0, 10)
    entry.writeUInt16LE(time, 12)
    entry.writeUInt16LE(date, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(bytes.length, 20)
    entry.writeUInt32LE(bytes.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)
    offset += local.length + name.length + bytes.length
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory
  end.writeUInt16LE(central.length / 2, 8)
  end.writeUInt16LE(central.length / 2, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  res.end(Buffer.concat([directory, end]))
}

export function wallStore({ dir = 'wall' } = {}) {
  let root = process.cwd()
  const listeners = new Set()

  const paths = () => {
    const base = resolve(root, dir)
    return { base, index: join(base, 'index.json'), img: (id) => join(base, `${id}.jpg`) }
  }

  function readIndex() {
    const { index } = paths()
    try {
      const items = JSON.parse(readFileSync(index, 'utf8'))
      return Array.isArray(items) ? items : []
    } catch {
      return [] // no wall yet, or a file we cannot make sense of — start clean rather than throw
    }
  }

  function writeIndex(items) {
    const { base, index } = paths()
    mkdirSync(base, { recursive: true })
    writeFileSync(index, JSON.stringify(items, null, 1))
  }

  /**
   * What the browser gets: metadata plus a URL for the picture, never the bytes.
   *
   * Dimensions included, and filled in from the file for anything published before they were
   * recorded. The gallery lays out at each picture's true shape and crops nothing, so a picture
   * that arrives without a shape is one the wall has to guess at and then correct — visibly.
   */
  // Read once per picture: without this, every screen asking for the wall re-read the file of
  // every picture that was shared before sizes were written into the index.
  const measured = new Map()

  const forClient = (entry) => {
    let size = entry.w && entry.h ? { w: entry.w, h: entry.h } : measured.get(entry.id)
    if (!size) {
      size = imageSizeOf(paths().img(entry.id))
      if (size) measured.set(entry.id, size)
      else size = { w: 3, h: 4 }
    }
    return {
      id: entry.id,
      image: `api/wall/img/${entry.id}.jpg`,
      // What it is called when somebody downloads it from the admin page.
      name: downloadName(entry),
      w: size.w,
      h: size.h,
      levels: entry.levels,
      shownHue: entry.shownHue,
      ts: entry.ts,
    }
  }

  function announce(message) {
    const line = `data: ${JSON.stringify(message)}\n\n`
    for (const res of listeners) {
      try {
        res.write(line)
      } catch {
        listeners.delete(res)
      }
    }
  }

  /** How big a picture is on disk. Only the admin page asks, so this is not on any hot path. */
  function sizeOf(id) {
    try {
      return statSync(paths().img(id)).size
    } catch {
      return 0 // listed but the file is gone — the admin page shows it so it can be tidied away
    }
  }

  const json = (res, code, body) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json')
    // The wall polls as a backstop behind the event stream; a cached list would make that
    // backstop useless in exactly the case it exists for.
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  function readBody(req) {
    return new Promise((ok, fail) => {
      let size = 0
      const parts = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_UPLOAD) {
          fail(new Error('upload too large'))
          req.destroy()
          return
        }
        parts.push(chunk)
      })
      req.on('end', () => ok(Buffer.concat(parts).toString('utf8')))
      req.on('error', fail)
    })
  }

  async function handle(req, res, next) {
    const url = new URL(req.url, 'http://x')
    const path = url.pathname.replace(/^\/+/, '')
    if (!path.startsWith('api/wall')) return next()
    const rest = path.slice('api/wall'.length).replace(/^\/+/, '')

    // ── one picture: fetch it, or remove it for good ──
    if (rest.startsWith('img/')) {
      const id = rest.slice(4).replace(/\.jpg$/, '')
      // Ids are generated here and are always UUIDs; anything else is someone walking the
      // filesystem, and there is no reason to be polite about it.
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res, 400, { error: 'bad id' })
      const file = paths().img(id)

      if (req.method === 'DELETE') {
        const before = readIndex()
        const kept = before.filter((e) => e.id !== id)
        if (kept.length === before.length && !existsSync(file)) {
          return json(res, 404, { error: 'no such picture' })
        }
        // The index first: a picture still listed but missing its file shows a broken frame on
        // the wall, while a file with no index entry is merely an orphan nobody looks at.
        writeIndex(kept)
        try {
          unlinkSync(file)
        } catch {}
        announce({ kind: 'removed', id })
        return json(res, 200, { removed: id, kept: kept.length })
      }

      if (!existsSync(file)) return json(res, 404, { error: 'no such picture' })
      res.statusCode = 200
      res.setHeader('content-type', 'image/jpeg')
      // Content never changes for a given id, so the wall re-renders without re-fetching.
      res.setHeader('cache-control', 'public, max-age=31536000, immutable')
      res.end(readFileSync(file))
      return
    }

    // ── many pictures at once, as a zip ──
    // GET for all of them; POST from a form for a selection, because a list of a few hundred ids
    // is too long to put in an address.
    if (rest === 'zip') {
      let entries = readIndex()
      const day = new Date().toISOString().slice(0, 10)
      let zipName = `share-your-sky-photos-${day}.zip`
      if (req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req))
        const wanted = new Set((form.get('ids') ?? '').split(',').filter((id) => /^[0-9a-f-]{36}$/i.test(id)))
        entries = entries.filter((e) => wanted.has(e.id))
        zipName = `share-your-sky-photos-${day}-${entries.length}-selected.zip`
      } else if (req.method !== 'GET') {
        return json(res, 405, { error: `${req.method} not allowed here` })
      }
      if (!entries.length) return json(res, 404, { error: 'no pictures to download' })
      return sendZip(
        res,
        zipName,
        entries.map((e) => ({ name: downloadName(e), path: paths().img(e.id), ts: e.ts }))
      )
    }

    // ── live updates ──
    if (rest === 'stream') {
      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('connection', 'keep-alive')
      res.write(': open\n\n')
      listeners.add(res)
      // A proxy or a sleeping wifi adapter will drop a stream that says nothing for minutes.
      const beat = setInterval(() => {
        try {
          res.write(': beat\n\n')
        } catch {
          clearInterval(beat)
        }
      }, 25000)
      req.on('close', () => {
        clearInterval(beat)
        listeners.delete(res)
      })
      return
    }

    if (rest !== '') return json(res, 404, { error: 'no such endpoint' })

    if (req.method === 'GET') {
      const all = readIndex()
      // `?all=1` is the admin page: everything ever shared, with what each costs on disk and
      // whether it is currently on the wall. The wall itself asks for neither.
      if (url.searchParams.get('all')) {
        const items = all.map((entry) => ({ ...forClient(entry), bytes: sizeOf(entry.id) }))
        return json(res, 200, {
          items,
          kept: items.length,
          onWall: Math.min(items.length, ON_THE_WALL),
          bytes: items.reduce((sum, i) => sum + i.bytes, 0),
        })
      }
      return json(res, 200, { items: all.slice(0, ON_THE_WALL).map(forClient), kept: all.length })
    }

    if (req.method === 'POST') {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch (err) {
        return json(res, 400, { error: `unreadable body: ${err.message}` })
      }

      const match = /^data:image\/jpeg;base64,(.+)$/s.exec(body.image ?? '')
      if (!match) return json(res, 400, { error: 'image must be a jpeg data URL' })

      const bytes = Buffer.from(match[1], 'base64')
      const size = imageSize(bytes) ?? { w: 3, h: 4 }
      const entry = {
        id: randomUUID(),
        w: size.w,
        h: size.h,
        levels: body.levels ?? null,
        shownHue: body.shownHue ?? null,
        ts: Date.now(),
      }
      const { base } = paths()
      mkdirSync(base, { recursive: true })
      writeFileSync(paths().img(entry.id), bytes)
      writeIndex([entry, ...readIndex()])

      announce({ kind: 'published', entry: forClient(entry) })
      return json(res, 201, { entry: forClient(entry) })
    }

    if (req.method === 'DELETE') {
      const emptied = readIndex().length
      try {
        rmSync(paths().base, { recursive: true, force: true })
      } catch {}
      announce({ kind: 'cleared' })
      return json(res, 200, { ok: true, emptied })
    }

    return json(res, 405, { error: `${req.method} not allowed here` })
  }

  // Braces, not an expression body. A `configureServer` hook that *returns* a function is
  // telling Vite to call it after the internal middlewares are installed — and a connect app is
  // itself a function, so returning `use()`'s result had Vite invoking the whole middleware
  // stack with no request at startup, which took the preview server down before it listened.
  const install = (server) => {
    server.middlewares.use((req, res, next) => handle(req, res, next))
  }

  return {
    name: 'share-your-sky-wall',
    configResolved(config) {
      root = config.root
    },
    // Both, because the exhibit runs `preview` and the bench runs `dev`, and a wall that only
    // works on one of them is a fault nobody finds until the day of the install.
    configureServer: install,
    configurePreviewServer: install,
  }
}
