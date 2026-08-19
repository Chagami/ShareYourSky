// Gallery persistence, shared between the interaction screen and the gallery wall.
//
// localStorage keeps the wall populated across reboots; BroadcastChannel pushes a newly
// published image to an already-open wall instantly. Same machine, same browser — the same
// arrangement FiltersNew used. Swap these two functions for a fetch to a server if the wall
// ever needs to live on a different device.

const KEY = 'isitreal_gallery_v1'
const CHANNEL = 'isitreal'
const MAX_ITEMS = 24

const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null

export function list() {
  try {
    const raw = localStorage.getItem(KEY)
    const items = raw ? JSON.parse(raw) : []
    return Array.isArray(items) ? items : []
  } catch {
    return []
  }
}

/**
 * Store an entry and announce it. Data URLs are big and localStorage quota is small, so on
 * a quota error the oldest entries are dropped until the write fits rather than losing the
 * image the visitor just made.
 */
export function publish({ image, palette }) {
  const entry = { id: newId(), image, palette, ts: Date.now() }
  let items = [entry, ...list()].slice(0, MAX_ITEMS)

  while (items.length) {
    try {
      localStorage.setItem(KEY, JSON.stringify(items))
      break
    } catch {
      if (items.length === 1) break // single image over quota: keep it in memory only
      items = items.slice(0, items.length - 1)
    }
  }

  bc?.postMessage({ kind: 'published', entry })
  return entry
}

export function clear() {
  try {
    localStorage.removeItem(KEY)
  } catch {}
  bc?.postMessage({ kind: 'cleared' })
}

/** Called with the full, newest-first list whenever it changes — in this tab or another. */
export function subscribe(onChange) {
  if (bc) bc.addEventListener('message', () => onChange(list()))
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) onChange(list())
  })
}

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return String(Date.now()) + Math.random().toString(16).slice(2)
}
