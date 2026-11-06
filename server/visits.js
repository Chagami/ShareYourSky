// Every turn at the exhibit, as a CSV on the machine that serves it: when the photo was taken and
// how the turn ended. The admin page's charts are drawn from it.
//
//   POST   api/visit         one { taken, outcome, downloaded }; appends a row
//   GET    api/visit         every row, as JSON, for the charts
//   GET    api/visit.csv     every row, reconstructed ones included and marked, as a download
//   DELETE api/visit         start a fresh file (the old one is gone for good; the history
//                            reconstructed from the answers log is not touched)
//
// One row per visitor who took a photo, written when the turn ends — on "Start again", on the idle
// start-over, or when the page is closed mid-turn. Someone who never pressed the shutter is not a
// visit; there is nothing to say about them but that they walked past.
//
//   taken       when the shutter fired (ISO time; the admin page bins it by its own clock)
//   outcome     shared     put a picture on the wall
//               declined   pressed "Don't share"
//               abandoned  left before choosing — Start again, or walked away
//   downloaded  1 if they opened the take-home QR code once it was ready, else 0. Opening the
//               code is all the kiosk can see; whether a phone then scanned it happens elsewhere.
//
// Nothing about the visitor is kept, only the time and what they pressed.
//
// The time before this log existed is filled in from what the exhibit already kept: every visitor
// who reached "Is this image real?" left a pair of answers in data/answers.csv when they moved on,
// and one who shared left a `shared` row a few seconds before them (before that row existed, the
// picture on the wall says the same). So each of those turns comes back as shared or not. What it
// cannot give back: the visitors who left before the question, which turns were "Don't share"
// rather than walking away at the question (all are counted as declined), the shutter time (it is
// the time they answered, a minute or two later), and downloads (the code was not logged). These
// rows are marked `reconstructed`, are never written to visits.csv, and stop where it starts.
//
// No authentication, for the same reason as the wall and the answers: a LAN exhibit with no route
// in from outside.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HEADER = 'taken,outcome,downloaded\n'
// The download adds where each row came from; `downloaded` is blank where it was never known.
const EXPORT_HEADER = 'taken,outcome,downloaded,source\n'
export const OUTCOMES = ['shared', 'declined', 'abandoned']
const MAX_BODY = 4096
// A turn is minutes long. A `taken` further off than this is a clock gone wrong, not a visitor.
const PLAUSIBLE = 24 * 60 * 60 * 1000

/** Rows of the file, oldest first, as { taken (ms), outcome, downloaded (bool) }. */
export function parseVisits(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    const [taken, outcome, downloaded] = line.trim().split(',')
    if (!taken || taken === 'taken' || !OUTCOMES.includes(outcome)) continue
    const at = Date.parse(taken)
    if (!Number.isFinite(at)) continue
    out.push({ taken: at, outcome, downloaded: downloaded === '1' })
  }
  return out
}

// Every turn that reached the question wrote an `unedited` answer; that row stands for the turn.
// Its share is found either side of it, because the log has had two shapes:
//   now      the share is written, then ~3.7s later both answers together — the share comes first
//   earlier  the answers went in one at a time as they were given, and the share (on the wall
//            only; the `shared` row came later) up to a few minutes after the second
const SHARE_BEFORE = 15 * 1000
const TURN_MAX = 10 * 60 * 1000

/**
 * The turns before visits.csv began, from the answers log and the wall's timestamps: one per
 * visitor who reached the question before `before` (ms), as
 * { taken, outcome, downloaded: null, past: true }.
 */
export function pastVisits(answersText, wallTimes = [], before = Infinity) {
  const turns = []
  const shares = []
  for (const line of String(answersText).split('\n')) {
    const [time, stage] = line.trim().split(',')
    const at = Date.parse(time)
    if (!Number.isFinite(at)) continue
    if (stage === 'shared') shares.push(at)
    else if (stage === 'unedited') turns.push(at)
  }
  turns.sort((a, b) => a - b)
  // Before the answers log recorded shares, the wall did: a picture is stamped as it is published.
  const firstShareRow = shares.length ? Math.min(...shares) : Infinity
  const evidence = [...shares, ...wallTimes.filter((t) => t < firstShareRow)]
  const shared = new Set()
  for (const e of evidence) {
    const next = turns.findIndex((t) => t >= e)
    if (next >= 0 && turns[next] - e <= SHARE_BEFORE) shared.add(next)
    else {
      const prev = next < 0 ? turns.length - 1 : next - 1
      if (prev >= 0 && e - turns[prev] <= TURN_MAX) shared.add(prev)
    }
  }
  return turns
    .map((t, i) => ({ taken: t, outcome: shared.has(i) ? 'shared' : 'declined', downloaded: null, past: true }))
    .filter((v) => v.taken < before)
}

export function visitLog({ dir = 'data', file = 'visits.csv', answers = 'answers.csv', wall = 'wall' } = {}) {
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

  function append({ taken, outcome, downloaded }) {
    const { base, csv } = paths()
    mkdirSync(base, { recursive: true })
    const head = existsSync(csv) ? '' : HEADER
    appendFileSync(csv, `${head}${new Date(taken).toISOString()},${outcome},${downloaded ? 1 : 0}\n`, 'utf8')
  }

  const read = () => {
    const { csv } = paths()
    return existsSync(csv) ? readFileSync(csv, 'utf8') : HEADER
  }

  /** Every visit, oldest first: the reconstructed ones, then the logged ones. */
  function everything() {
    const logged = parseVisits(read())
    const before = logged.length ? Math.min(...logged.map((v) => v.taken)) : Infinity
    let past = []
    try {
      const answersCsv = join(paths().base, answers)
      const wallIndex = join(resolve(root, wall), 'index.json')
      const wallTimes = existsSync(wallIndex)
        ? JSON.parse(readFileSync(wallIndex, 'utf8')).map((e) => e?.ts).filter(Number.isFinite)
        : []
      if (existsSync(answersCsv)) past = pastVisits(readFileSync(answersCsv, 'utf8'), wallTimes, before)
    } catch {
      past = [] // history is a nicety; a file we cannot read must not take the charts down with it
    }
    return [...past, ...logged]
  }

  async function handle(req, res, next) {
    const path = new URL(req.url, 'http://x').pathname.replace(/^\/+/, '')
    if (path !== 'api/visit' && path !== 'api/visit.csv') return next()

    try {
      if (path === 'api/visit.csv') {
        if (req.method !== 'GET') return json(res, 405, { error: `${req.method} not allowed here` })
        res.statusCode = 200
        res.setHeader('content-type', 'text/csv; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.setHeader('content-disposition', `attachment; filename="${file}"`)
        const lines = everything().map(
          (v) => `${new Date(v.taken).toISOString()},${v.outcome},${v.past ? '' : v.downloaded ? 1 : 0},${v.past ? 'reconstructed' : 'logged'}`
        )
        return res.end(EXPORT_HEADER + lines.map((l) => l + '\n').join(''))
      }

      if (req.method === 'GET') {
        // Compact: a season of visits is tens of thousands of rows, and the page wants all of them.
        // [taken ms, outcome index, downloaded 0/1, reconstructed 0/1]
        const rows = everything().map((v) => [v.taken, OUTCOMES.indexOf(v.outcome), v.downloaded ? 1 : 0, v.past ? 1 : 0])
        return json(res, 200, { outcomes: OUTCOMES, rows })
      }

      if (req.method === 'POST') {
        let sent
        try {
          // sendBeacon posts text/plain; the body is the same JSON either way.
          sent = JSON.parse(await readBody(req))
        } catch {
          return json(res, 400, { error: 'expected JSON' })
        }
        const taken = Date.parse(sent?.taken)
        if (!Number.isFinite(taken) || Math.abs(Date.now() - taken) > PLAUSIBLE) {
          return json(res, 400, { error: 'taken must be an ISO time from the last day' })
        }
        const outcome = String(sent?.outcome ?? '')
        if (!OUTCOMES.includes(outcome)) return json(res, 400, { error: `outcome must be one of ${OUTCOMES.join(', ')}` })
        append({ taken, outcome, downloaded: sent?.downloaded === true })
        return json(res, 201, { ok: true })
      }

      if (req.method === 'DELETE') {
        rmSync(paths().csv, { force: true })
        return json(res, 200, { ok: true })
      }

      return json(res, 405, { error: `${req.method} not allowed here` })
    } catch (err) {
      return json(res, 500, { error: String(err?.message ?? err) })
    }
  }

  // Braces, not an expression body — see the same note in answers.js and wall.js.
  const install = (server) => {
    server.middlewares.use((req, res, next) => handle(req, res, next))
  }

  return {
    name: 'share-your-sky-visits',
    configResolved(config) {
      root = config.root
    },
    configureServer: install,
    configurePreviewServer: install,
  }
}
