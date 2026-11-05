// Take-home photos: one shared picture, uploaded to a Cloudflare R2 bucket with a small download
// page beside it, and a QR code that opens that page on a visitor's phone.
//
// Pure logic, no server and no Vite, so it can be tested on its own (scripts/r2-test.mjs does)
// and swapped for another store later without touching the kiosk. server/shareapi.js is what
// runs it in the background for the exhibit.
//
// R2 speaks the S3 API. One PutObject is all this needs, so instead of the whole AWS SDK it signs
// the request with aws4fetch (AWS Signature v4, no dependencies of its own) — the same thing
// Cloudflare's own R2 examples use. Endpoint https://<account>.r2.cloudflarestorage.com, region
// "auto", path-style keys.
//
// Every visitor gets a fresh random token, and the two objects are named after it:
//   <token>.jpg   the photograph                   image/jpeg
//   <token>.html  a page that shows and saves it   text/html; charset=utf-8
// Nothing else about the visitor goes anywhere. The bucket deletes both after a day, by a
// lifecycle rule set on the bucket (see the README) — the page says so, so the two must agree.

import { randomBytes } from 'node:crypto'
import { AwsClient } from 'aws4fetch'
import qrcode from 'qrcode-generator'

export const ENV_NAMES = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_BASE_URL']

// What the page tells the visitor. Must match the bucket's lifecycle rule.
export const KEPT_FOR = '24 hours'
export const EXHIBIT_NAME = 'Share Your Sky'

/**
 * The R2 settings from the environment. `missing` lists the names that are not set — names
 * only, never values, so it is safe to print.
 */
export function configFromEnv(env = process.env) {
  const missing = ENV_NAMES.filter((name) => !String(env[name] ?? '').trim())
  return {
    missing,
    ok: missing.length === 0,
    accountId: String(env.R2_ACCOUNT_ID ?? '').trim(),
    accessKeyId: String(env.R2_ACCESS_KEY_ID ?? '').trim(),
    secretAccessKey: String(env.R2_SECRET_ACCESS_KEY ?? '').trim(),
    bucket: String(env.R2_BUCKET ?? '').trim(),
    // No trailing slash, so `${publicBaseUrl}/${key}` is always one slash.
    publicBaseUrl: String(env.R2_PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, ''),
  }
}

/** 16 random bytes as URL-safe base64 — 22 characters, the same as Python's secrets.token_urlsafe(16). */
export function newToken() {
  return randomBytes(16).toString('base64url')
}

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/**
 * The download page. Self-contained — inline styles and one small inline script, nothing fetched
 * from anywhere but the photo beside it, which is referenced by relative path so the page works
 * wherever the bucket is served from.
 *
 * Saving to the photo library. A `download` link always lands in Files on an iPhone and in
 * Downloads on Android — never in Photos. On an iPhone the way into Photos is the share sheet,
 * whose "Save Image" does exactly that, so there the button opens the share sheet instead. The
 * photo is fetched as the page loads, because Safari only allows the share sheet straight from the
 * tap, with nothing awaited in between. Android's share sheet has no dependable "save to gallery",
 * and its downloads show up in the Gallery app anyway, so Android keeps the plain download. Without
 * the script, or if anything in it fails, the plain download link is what remains.
 */
export function buildPage({ token, exhibit = EXHIBIT_NAME, keptFor = KEPT_FOR }) {
  const photo = `./${encodeURIComponent(token)}.jpg`
  const name = escapeHtml(exhibit)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Your photo · ${name}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background: #040408;
    color: #f4f5f7;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    text-align: center;
    padding: max(20px, env(safe-area-inset-top)) 18px max(28px, env(safe-area-inset-bottom));
  }
  main { max-width: 560px; margin: 0 auto; }
  h1 { margin: 6px 0 4px; font-size: 1.5rem; letter-spacing: -0.01em; }
  .sub { margin: 0 0 18px; color: #949aa6; font-size: 0.95rem; }
  img {
    display: block;
    width: 100%;
    height: auto;
    border-radius: 14px;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12);
  }
  .download {
    display: block;
    margin: 22px 0 10px;
    padding: 18px 20px;
    border-radius: 999px;
    background: #ff8a2b;
    color: #1a0b02;
    font-size: 1.25rem;
    font-weight: 700;
    text-decoration: none;
  }
  .hint { margin: 0 0 22px; font-size: 1rem; color: #dfe3ea; }
  .hint:empty { display: none; }
  .note { margin: 0; font-size: 0.85rem; color: #949aa6; line-height: 1.5; }
</style>
</head>
<body>
<main>
  <h1>${name}</h1>
  <p class="sub">Your photo from the exhibit</p>
  <img src="${photo}" alt="Your photo from ${name}">
  <a class="download" id="save" href="${photo}" download="share-your-sky.jpg">Download</a>
  <p class="hint" id="hint"></p>
  <p class="note">This photo is deleted automatically after ${escapeHtml(keptFor)}.<br>${name}</p>
</main>
<script>
(function () {
  var save = document.getElementById('save')
  var hint = document.getElementById('hint')
  var ua = navigator.userAgent
  var ios = /iPhone|iPad|iPod/.test(ua) || (ua.indexOf('Macintosh') > -1 && navigator.maxTouchPoints > 1)
  if (/Android/.test(ua)) {
    hint.textContent = 'It goes to Downloads, and shows in your Gallery.'
    return
  }
  if (!ios || !navigator.canShare || !window.File || !window.fetch) return
  var file = null
  fetch(save.getAttribute('href'))
    .then(function (res) { return res.ok ? res.blob() : null })
    .then(function (blob) {
      if (!blob) return
      var f = new File([blob], 'share-your-sky.jpg', { type: 'image/jpeg' })
      if (!navigator.canShare({ files: [f] })) return
      file = f
      save.textContent = 'Save to Photos'
      hint.textContent = 'Then choose “Save Image”.'
    })
    .catch(function () {})
  save.addEventListener('click', function (e) {
    if (!file) return
    e.preventDefault()
    navigator.share({ files: [file] }).catch(function (err) {
      // Closing the sheet is a choice, not a failure; anything else falls back to the download.
      if (err && err.name !== 'AbortError') window.location.href = save.getAttribute('href')
    })
  })
})()
</script>
</body>
</html>
`
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * One PutObject to R2. Signed by aws4fetch, sent by `fetchImpl` (the global fetch unless a test
 * passes its own), and abandoned after `timeoutMs`. aws4fetch's own retrying is turned off: the
 * retries are uploadShare's, where they can be counted and logged.
 */
export async function putObject(cfg, key, body, contentType, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const client = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: 's3',
    region: 'auto',
    retries: 0,
  })
  const url = `https://${cfg.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(cfg.bucket)}/${encodeURIComponent(key)}`
  const signed = await client.sign(url, {
    method: 'PUT',
    body,
    headers: { 'content-type': contentType },
  })
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
  try {
    const res = await fetchImpl(signed, { signal: abort.signal })
    if (!res.ok) {
      // R2's error body is a short XML document; its <Code> is enough to say what went wrong.
      const text = await res.text().catch(() => '')
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1]
      throw new Error(`R2 answered ${res.status}${code ? ` ${code}` : ''}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Run `job` up to `attempts` times, waiting `waits[i]` between tries. */
async function withRetries(job, { attempts = 3, waits = [1000, 3000], onRetry } = {}) {
  let last
  for (let i = 0; i < attempts; i++) {
    try {
      return await job()
    } catch (err) {
      last = err
      if (i < attempts - 1) {
        onRetry?.(err, i + 1)
        await sleep(waits[Math.min(i, waits.length - 1)])
      }
    }
  }
  throw last
}

/**
 * Upload one photo and its page. Resolves to { token, url } — the url is the page, which is what
 * the QR code points at. Rejects only after every attempt at either object has failed.
 */
export async function uploadShare(cfg, jpegBytes, { attempts = 3, timeoutMs = 10000, waits, fetchImpl, onRetry, token = newToken() } = {}) {
  if (!cfg?.ok) throw new Error(`R2 is not configured: missing ${cfg?.missing?.join(', ') || 'settings'}`)
  const put = (key, body, type) =>
    withRetries(() => putObject(cfg, key, body, type, { timeoutMs, fetchImpl }), { attempts, waits, onRetry })
  // The photo first: a page that went up without its photo would be a broken page.
  await put(`${token}.jpg`, jpegBytes, 'image/jpeg')
  await put(`${token}.html`, buildPage({ token }), 'text/html; charset=utf-8')
  return { token, url: `${cfg.publicBaseUrl}/${encodeURIComponent(token)}.html` }
}

/**
 * The QR code for `text`, as an SVG: black modules on white, with the four-module white border
 * the standard asks for drawn into the image itself, so it scans even against the exhibit's dark
 * screen. One path, crisp at any size; error correction M, which survives a little glare.
 */
export function qrSvg(text, { margin = 4 } = {}) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const size = n + margin * 2
  let d = ''
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.isDark(y, x)) d += `M${x + margin} ${y + margin}h1v1h-1z`
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
  )
}
