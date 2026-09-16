// What visitors answered, as a CSV on the machine that serves the exhibit.
//
// The exhibit asks "Is this image real?" twice — of the picture the camera made on its own, and
// again of the same picture after the visitor has moved its colours somewhere the camera never
// put them — and each time offers a figure to drag between No and Yes. Those two positions are
// the one thing this exhibit learns that nobody can read off the wall afterwards, so they are
// written down, and the last screen shows the pair back to the room.
//
//   POST   api/answer          one { stage, value }; appends a row
//   GET    api/answer          the whole file, as a download for whoever runs the exhibit
//   GET    api/answer/summary  both stages binned across 0..1, for the Reality screen
//   DELETE api/answer          start a fresh file (the old one is gone for good)
//
// One row per visitor per question, written when they leave that screen, and only if they
// actually moved the figure — an untouched slider is not an answer of "undecided", it is
// somebody who walked away, and averaging the two together would quietly bury the difference.
//
// No authentication, for the same reason as the wall: this is a LAN exhibit with no route in
// from outside, and a shared secret here would be a thing for a technician to lose rather than
// a defence against anybody.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HEADER = 'time,stage,value\n'

// Which picture an answer is about. `unedited` is the camera's own; `edited` is after the
// visitor has changed its colours.
const STAGES = ['unedited', 'edited']

// How many buckets the Reality screen's charts are drawn from. Fine enough that a cluster round
// one answer shows as a cluster, coarse enough that a quiet morning is not a row of single bars.
const BINS = 25

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
  function append(stage, value) {
    const { base, csv } = paths()
    mkdirSync(base, { recursive: true })
    // The header goes in with the first row rather than at startup, so an exhibit that runs all
    // day without a single answer does not leave a file claiming to hold some.
    const head = existsSync(csv) ? '' : HEADER
    appendFileSync(csv, `${head}${new Date().toISOString()},${stage},${value.toFixed(3)}\n`, 'utf8')
  }

  /**
   * Every answer on file, as { stage, value }.
   *
   * Rows of two fields are from before there were two questions to tell apart; there was only
   * the one then, and it was the edited picture. Reading them as that is better than dropping
   * a day's answers on the floor because the file grew a column.
   */
  function rows() {
    const { csv } = paths()
    if (!existsSync(csv)) return []
    const out = []
    for (const line of readFileSync(csv, 'utf8').split('\n')) {
      const cells = line.trim().split(',')
      if (cells.length < 2 || cells[0] === 'time') continue
      const stage = cells.length > 2 ? cells[1] : 'edited'
      const value = Number(cells.at(-1))
      if (!STAGES.includes(stage) || !Number.isFinite(value)) continue
      out.push({ stage, value: Math.min(1, Math.max(0, value)) })
    }
    return out
  }

  /** The same, counted into buckets across 0..1 — one array per stage. */
  function summary() {
    const counts = Object.fromEntries(STAGES.map((k) => [k, new Array(BINS).fill(0)]))
    const totals = Object.fromEntries(STAGES.map((k) => [k, 0]))
    for (const { stage, value } of rows()) {
      // The very top of the range belongs to the last bucket rather than to one past the end.
      counts[stage][Math.min(BINS - 1, Math.floor(value * BINS))]++
      totals[stage]++
    }
    const mean = (k) => {
      const of = rows().filter((r) => r.stage === k)
      return of.length ? of.reduce((a, r) => a + r.value, 0) / of.length : null
    }
    return { bins: BINS, counts, totals, means: Object.fromEntries(STAGES.map((k) => [k, mean(k)])) }
  }

  async function handle(req, res, next) {
    const path = new URL(req.url, 'http://x').pathname.replace(/^\/+/, '')
    if (path !== 'api/answer' && path !== 'api/answer/summary') return next()

    if (path === 'api/answer/summary') {
      if (req.method !== 'GET') return json(res, 405, { error: `${req.method} not allowed here` })
      try {
        return json(res, 200, summary())
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }

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
      let sent
      try {
        sent = JSON.parse(await readBody(req))
      } catch {
        return json(res, 400, { error: 'expected JSON' })
      }
      const stage = String(sent?.stage ?? '')
      if (!STAGES.includes(stage)) {
        return json(res, 400, { error: `stage must be one of ${STAGES.join(', ')}` })
      }
      const value = Number(sent?.value)
      // Not `!value`: zero is the whole of one end of the scale, and it is an answer.
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        return json(res, 400, { error: 'value must be a number from 0 to 1' })
      }
      try {
        append(stage, value)
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
