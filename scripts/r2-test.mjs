#!/usr/bin/env node
//
// Check the take-home photo setup without running the booth: upload one picture to R2 the way
// the exhibit does, and print the link.
//
//   npm run r2:test                       uploads img/sky/01-ChabotEvents.jpg
//   npm run r2:test -- path/to/photo.jpg  uploads that instead
//
// Reads the R2 settings from .env (see .env.example). Prints the names of any that are missing,
// never their values. Writes the QR code to a temporary SVG and prints where, so it can be opened
// and scanned with a phone. The test upload is deleted by the bucket's lifecycle rule like any
// other.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configFromEnv, qrSvg, uploadShare } from '../server/share.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const envFile = join(root, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

const cfg = configFromEnv()
if (!cfg.ok) {
  console.error(`Not configured. ${existsSync(envFile) ? '.env is' : 'There is no .env, so these are'} missing: ${cfg.missing.join(', ')}`)
  console.error('Copy .env.example to .env and fill it in — see "Take-home photos" in the README.')
  process.exit(1)
}

const photo = process.argv[2] ?? join(root, 'img/sky/01-ChabotEvents.jpg')
const bytes = readFileSync(photo)
if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
  console.error(`${photo} is not a JPEG.`)
  process.exit(1)
}

console.log(`Uploading ${photo} (${Math.round(bytes.length / 1024)} KB) to bucket "${cfg.bucket}"…`)
const began = Date.now()
try {
  const { url } = await uploadShare(cfg, bytes, {
    onRetry: (err, n) => console.warn(`  attempt ${n} failed: ${err.message} — retrying`),
  })
  const qrFile = join(tmpdir(), 'share-your-sky-test-qr.svg')
  writeFileSync(qrFile, qrSvg(url))
  console.log(`Done in ${((Date.now() - began) / 1000).toFixed(1)}s.\n`)
  console.log(`  Page: ${url}`)
  console.log(`  QR:   ${qrFile}\n`)
  console.log('Open the page on a phone: the photo should show, Download should save it, and')
  console.log('press-and-hold should offer "Save to Photos" on an iPhone.')
} catch (err) {
  console.error(`Failed: ${err.message}`)
  console.error('A 403 usually means the API token cannot write to this bucket; a timeout, no network.')
  process.exit(1)
}
