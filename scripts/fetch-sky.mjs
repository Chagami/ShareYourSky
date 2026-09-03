// Top up img/sky/ with public-domain astrophotography from NASA's image library.
//
//   npm run sky
//
// Optional, and not part of running the exhibit. The gallery reads the folder itself, so the
// ordinary way to curate the wall is to drop pictures into `img/sky/` — any name, any of jpeg,
// png or webp. This is only for filling an empty folder or padding a thin one out.
//
// It never touches what is already there, and it writes its credits to CREDITS-nasa.txt rather
// than claiming to describe a folder it only partly filled. Two things worth knowing before
// running it: the search is indiscriminate — artists' impressions and diagrams come back
// alongside photographs — and while NASA imagery is generally public domain, that is a general
// statement and not a licence. Both want a human pass before anything opens.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv[2] ?? 'img/sky'
const WANT = Number(process.argv[3] ?? 40)

const QUERIES = [
  'hubble nebula', 'hubble spiral galaxy', 'hubble star cluster', 'planetary nebula hubble',
  'supernova remnant hubble', 'webb telescope nebula', 'webb telescope galaxy',
  'hubble globular cluster', 'hubble galaxy cluster', 'emission nebula',
]

/** Width and height straight out of the JPEG's frame header. */
function jpegSize(buf) {
  let i = 2
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
    }
    const len = buf.readUInt16BE(i + 2)
    if (len < 2) break
    i += 2 + len
  }
  return null
}

mkdirSync(OUT, { recursive: true })

// What is already here, by filename. The folder is the record — there is no manifest to keep in
// step with it, because a manifest that fell out of step showed a wall of black rectangles.
const already = new Set(
  existsSync(OUT) ? readdirSync(OUT).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)) : []
)
console.log(`${already.size} already in ${OUT}; looking for up to ${WANT} more`)

const added = []

for (const q of QUERIES) {
  if (added.length >= WANT) break
  let items = []
  try {
    const res = await fetch(
      `https://images-api.nasa.gov/search?q=${encodeURIComponent(q)}&media_type=image&page_size=40`
    )
    items = (await res.json()).collection?.items ?? []
  } catch (err) {
    console.log(`  ${q}: search failed — ${err.message}`)
    continue
  }

  let n = 0
  for (const item of items) {
    if (added.length >= WANT) break
    const meta = item.data?.[0]
    const id = meta?.nasa_id
    const thumb = item.links?.[0]?.href
    if (!id || !thumb) continue

    const file = `${id.replace(/[^\w-]/g, '_').slice(0, 60)}.jpg`
    if (already.has(file)) continue

    // Prefer a wall-sized copy; fall back to whatever the search handed back.
    let buf = null
    for (const url of [
      thumb.replace(/~(thumb|small|medium|large|orig)\.jpg$/, '~large.jpg'),
      thumb.replace(/~(thumb|small|medium|large|orig)\.jpg$/, '~medium.jpg'),
      thumb,
    ]) {
      try {
        const r = await fetch(url)
        if (!r.ok) continue
        const b = Buffer.from(await r.arrayBuffer())
        // Too small to hang on a 4K wall; too big to ship four of them per screen.
        if (b.length < 40_000 || b.length > 2_400_000) continue
        buf = b
        break
      } catch {
        /* try the next size */
      }
    }
    if (!buf) continue

    const size = jpegSize(buf)
    if (!size?.w || !size?.h) continue
    if (size.w < 700 && size.h < 700) continue

    writeFileSync(join(OUT, file), buf)
    already.add(file)
    added.push({ file, ...size, title: (meta.title || '').slice(0, 120), credit: (meta.secondary_creator || meta.center || 'NASA').slice(0, 80) })
    n++
  }
  console.log(`  ${q.padEnd(28)} +${n}  (${added.length} added)`)
}

if (added.length) {
  writeFileSync(
    join(OUT, 'CREDITS-nasa.txt'),
    'Only the pictures this script fetched — not the whole folder.\n\n' +
      'From the NASA Image and Video Library (images.nasa.gov), which is generally public\n' +
      'domain. That is a general statement, not a licence: check images.nasa.gov for the\n' +
      'authoritative word on any one of them before print or promotional use.\n\n' +
      added.map((e) => `${e.file}\n  ${e.title}\n  ${e.credit}\n`).join('\n')
  )
}

console.log(`\n${added.length} added; ${already.size} pictures in ${OUT}`)
console.log('The gallery reads the folder directly — nothing else to run.')
