// What visitors answered, as a CSV on the machine that serves the exhibit.
//
// The adjust screen ends by asking "Is this image real?" and offering a figure to drag between
// No and Yes. That position is the answer, and it is the one thing this exhibit learns that
// nobody can read off the wall afterwards — so it is written down.
//
//   POST   api/answer   one { value } between 0 and 1; appends a row
//   GET    api/answer   the whole file, as a download for whoever is running the exhibit
//   DELETE api/answer   start a fresh file (the old one is gone for good)
//
// One row per visitor, written when they leave the screen, and only if they actually moved the
// figure — an untouched slider is not an answer of "undecided", it is somebody who walked away,
// and averaging the two together would quietly bury the difference.
//
// No authentication, for the same reason as the wall: this is a LAN exhibit with no route in
// from outside, and a shared secret here would be a thing for a technician to lose rather than
// a defence against anybody.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HEADER = 'time,value\n'

// A body this size is already a malformed request; the endpoint takes one small number.
const MAX_BODY = 4096

export function answerLog({ dir = 'data', file = 'answers.csv' } = {}) {
  let root = process.cwd()

  const paths = () => {
    const base = resolve(root, dir)
    return { base, csv: join(base, file) }
  }

  const json = (res, code, body) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  function readBody(req) {
    return new Promise((ok, fail) => {
      let size = 0
      const parts = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY) {
          fail(new Error('body too large'))
          req.destroy()
          return
        }
        parts.push(chunk)
      })
      req.on('end', () => ok(Buffer.concat(parts).toString('utf8')))
      req.on('error', fail)
    })
  }

  /** Append one row, making the file and its folder if this is the first answer of the day. */
  function append(value) {
    const { base, csv } = paths()
    mkdirSync(base, { recursive: true })
    // The header goes in with the first row rather than at startup, so an exhibit that runs all
    // day without a single answer does not leave a file claiming to hold some.
    const head = existsSync(csv) ? '' : HEADER
    appendFileSync(csv, `${head}${new Date().toISOString()},${value.toFixed(3)}\n`, 'utf8')
  }

  async function handle(req, res, next) {
    const path = new URL(req.url, 'http://x').pathname.replace(/^\/+/, '')
    if (path !== 'api/answer') return next()

    if (req.method === 'GET') {
      const { csv } = paths()
      const body = existsSync(csv) ? readFileSync(csv, 'utf8') : HEADER
      res.statusCode = 200
      res.setHeader('content-type', 'text/csv; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      // Named, so that whoever opens it from the admin page gets a file rather than a wall of
      // text in a browser tab.
      res.setHeader('content-disposition', `attachment; filename="${file}"`)
      return res.end(body)
    }

    if (req.method === 'POST') {
      let value
      try {
        value = JSON.parse(await readBody(req))?.value
      } catch {
        return json(res, 400, { error: 'expected JSON' })
      }
      value = Number(value)
      // Not `!value`: zero is the whole of one end of the scale, and it is an answer.
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        return json(res, 400, { error: 'value must be a number from 0 to 1' })
      }
      try {
        append(value)
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
      return json(res, 201, { ok: true })
    }

    if (req.method === 'DELETE') {
      try {
        rmSync(paths().csv, { force: true })
      } catch {}
      return json(res, 200, { ok: true })
    }

    return json(res, 405, { error: `${req.method} not allowed here` })
  }

  // Braces, not an expression body: a hook that *returns* a function tells Vite to call it after
  // its own middlewares are installed, and a connect app is itself a function — see the same
  // note in wall.js, where returning `use()`'s result took the preview server down at startup.
  const install = (server) => {
    server.middlewares.use((req, res, next) => handle(req, res, next))
  }

  return {
    name: 'share-your-sky-answers',
    configResolved(config) {
      root = config.root
    },
    // Both, because the exhibit runs `preview` and the bench runs `dev`.
    configureServer: install,
    configurePreviewServer: install,
  }
}
