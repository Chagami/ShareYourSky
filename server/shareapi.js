// Take-home photos, as the kiosk asks for them. See server/share.js for what is uploaded and why.
//
//   POST api/share       the JPEG itself (content-type image/jpeg), or { image: jpeg data URL };
//                        starts uploading in the background and answers at once with { id },
//                        never waiting on the upload
//   GET  api/share/<id>                           { state: 'pending' }
//                                                 { state: 'ready', url, qr }   qr is an SVG
//                                                 { state: 'failed' }
//                                                 { state: 'off' }   R2 is not configured here
//
// The upload must never hold up or bring down the exhibit, so it runs on its own: every attempt
// has a timeout, each object is tried three times, and whatever happens is caught and becomes
// 'failed', which the kiosk shows as "couldn't make a link, try again".
//
// Nothing is kept: jobs live in memory and are forgotten half an hour later, the picture with
// them. The id the kiosk polls with is not the token in the link, so nothing that reaches the
// browser before the upload has finished can be turned into the address of somebody's photo.
// The log names a token by its first six characters only — enough to find one in the bucket
// while debugging, not enough to open it.

import { randomUUID } from 'node:crypto'
import { configFromEnv, qrSvg, uploadShare } from './share.js'

const MAX_UPLOAD = 12 * 1024 * 1024 // the same ceiling as api/wall
const FORGET_AFTER = 30 * 60 * 1000

export function shareApi({ upload = uploadShare, config = () => configFromEnv() } = {}) {
  const jobs = new Map()

  const json = (res, code, body) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  function readBody(req, { raw = false } = {}) {
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
      req.on('end', () => {
        const all = Buffer.concat(parts)
        ok(raw ? all : all.toString('utf8'))
      })
      req.on('error', fail)
    })
  }

  function start(bytes) {
    const id = randomUUID()
    const job = { state: 'pending', at: Date.now() }
    jobs.set(id, job)
    setTimeout(() => jobs.delete(id), FORGET_AFTER).unref?.()

    const began = Date.now()
    upload(config(), bytes, {
      onRetry: (err, n) => console.warn(`[share] attempt ${n} failed (${err.message}), retrying`),
    })
      .then(({ token, url }) => {
        Object.assign(job, { state: 'ready', url, qr: qrSvg(url) })
        console.log(`[share] uploaded ${token.slice(0, 6)}… in ${((Date.now() - began) / 1000).toFixed(1)}s`)
      })
      .catch((err) => {
        job.state = 'failed'
        console.error(`[share] failed: ${err?.message ?? err}`)
      })
    return id
  }

  async function handle(req, res, next) {
    const path = new URL(req.url, 'http://x').pathname.replace(/^\/+/, '')
    if (path !== 'api/share' && !path.startsWith('api/share/')) return next()

    try {
      if (path === 'api/share') {
        if (req.method !== 'POST') return json(res, 405, { error: `${req.method} not allowed here` })
        let bytes
        try {
          if (/^image\/jpeg(;|$)/i.test(req.headers?.['content-type'] ?? '')) {
            bytes = await readBody(req, { raw: true })
          } else {
            const match = /^data:image\/jpeg;base64,(.+)$/s.exec(JSON.parse(await readBody(req))?.image ?? '')
            if (match) bytes = Buffer.from(match[1], 'base64')
          }
        } catch (err) {
          return json(res, 400, { error: `unreadable body: ${err.message}` })
        }
        // Every JPEG starts FF D8. Anything else is not one, whatever it says it is.
        if (!bytes || bytes[0] !== 0xff || bytes[1] !== 0xd8) return json(res, 400, { error: 'image must be a JPEG' })
        if (!config().ok) return json(res, 200, { state: 'off' })
        return json(res, 202, { id: start(bytes) })
      }

      if (req.method !== 'GET') return json(res, 405, { error: `${req.method} not allowed here` })
      const job = jobs.get(path.slice('api/share/'.length))
      if (!job) return json(res, 404, { state: 'failed', error: 'no such share' })
      const { state, url, qr } = job
      return json(res, 200, state === 'ready' ? { state, url, qr } : { state })
    } catch (err) {
      // Nothing about a take-home link is worth a broken response to the kiosk.
      return json(res, 500, { state: 'failed', error: String(err?.message ?? err) })
    }
  }

  // Braces, not an expression body — see the same note in answers.js and wall.js.
  const install = (server) => {
    server.middlewares.use((req, res, next) => handle(req, res, next))
  }

  return {
    name: 'share-your-sky-take-home',
    configureServer: install,
    configurePreviewServer: install,
  }
}
