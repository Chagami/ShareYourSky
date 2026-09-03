// A picture's dimensions, out of its own header.
//
// Shared because both halves of the wall need them and for the same reason: the gallery lays
// out at each picture's true shape and crops nothing, so it has to know every shape before a
// single picture has loaded. Guessing and correcting afterwards means a wall that visibly
// rearranges itself for the first few seconds of every hour it is switched on.
//
// Only as much of the file as it takes to find them — an astrophotograph can be a couple of
// megabytes and there is no reason to hold thirty of those in memory to learn how wide they are.

import { openSync, readSync, closeSync } from 'node:fs'

/** Enough for any header. EXIF and an embedded thumbnail sit in front of a JPEG's frame marker. */
const HEAD = 1_000_000

export function imageSize(buf) {
  // PNG: IHDR is always the first chunk.
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  }

  // WebP: the dimensions live in whichever VP8 flavour the file used.
  if (buf.length > 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buf.toString('latin1', 12, 16)
    if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) }
    if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff }
    if (kind === 'VP8L') {
      const n = buf.readUInt32LE(21)
      return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 }
    }
  }

  // JPEG: walk the markers to the start-of-frame. A walk, not a fixed offset, because what sits
  // in front of it varies with whatever wrote the file.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
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
  }

  return null
}

/** The same, reading only the front of a file rather than all of it. */
export function imageSizeOf(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(HEAD)
    const read = readSync(fd, buf, 0, HEAD, 0)
    return imageSize(buf.subarray(0, read))
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
