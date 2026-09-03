// Gallery persistence, shared between the interaction screen and the gallery wall.
//
// The two screens are two devices: the interaction runs on a tablet over the LAN, the wall runs
// somewhere else. So the pictures live on whichever machine serves the pages (see
// server/wall.js) and both screens talk to it over `api/wall`.
//
// `localStorage` is still here, as the fallback for when that machine cannot be reached. It
// cannot be the main store — it is scoped to one origin in one browser, so the wall and the
// tablet each had their own private copy and neither could see the other's — but it is exactly
// right for the thing that must never fail: a visitor pressing Share and losing their picture
// because the network blinked. Nothing about the visitor's turn depends on the server being up.

const KEY = 'shareyoursky_gallery_v1'
const CHANNEL = 'shareyoursky'
const MAX_LOCAL = 8 // only a holding pen now; the wall itself is on disk on the server

// Relative, so it resolves against whatever address this page was opened at, and keeps working
// if the exhibit is ever served from a subdirectory.
const API = 'api/wall'

const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null

/** Whether the last thing we tried reached the server. Reported in the debug overlay. */
export let online = null

// ── the wall ────────────────────────────────────────────────────────────────

/** Everything the wall should be showing, newest first. */
export async function list() {
  try {
    const res = await fetch(API, { cache: 'no-store' })
    if (!res.ok) throw new Error(`${res.status}`)
    const body = await res.json()
    online = true
    return body.items ?? []
  } catch {
    online = false
    return localList()
  }
}

/**
 * Store a picture and announce it.
 *
 * Resolves either way. A visitor pressing Share must never see a failure, and never has to:
 * if the server is unreachable the picture is kept locally and the turn carries on exactly as
 * before. The return value says which happened, so the exhibit can be told about it without
 * the visitor being.
 */
export async function publish({ image, levels, shownHue }) {
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image, levels, shownHue }),
    })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const body = await res.json()
    online = true
    return { entry: body.entry, kept: 'wall' }
  } catch (err) {
    online = false
    const entry = keepLocally({ image, levels, shownHue })
    bc?.postMessage({ kind: 'published', entry })
    return { entry, kept: 'this device only', why: err.message }
  }
}

/** Empty the wall. For whoever is running the exhibit, not for a visitor. */
export async function clear() {
  try {
    await fetch(API, { method: 'DELETE' })
  } catch {}
  try {
    localStorage.removeItem(KEY)
  } catch {}
  bc?.postMessage({ kind: 'cleared' })
}

/**
 * Called with the full, newest-first list whenever it changes.
 *
 * Three ways in, because the wall runs unattended all day and a picture that never appears is
 * the one fault a visitor will actually notice:
 *   the event stream    a picture shows up as it is made, from any device
 *   a slow poll         the backstop, for a stream that died quietly
 *   BroadcastChannel    the offline case, where both screens are the same browser
 */
export function subscribe(onChange) {
  const refresh = () => list().then(onChange)

  if (typeof EventSource !== 'undefined') {
    try {
      const stream = new EventSource(`${API}/stream`)
      // Any message at all means something changed; re-reading the list is cheap and means the
      // wall cannot drift out of order from a message that arrived out of order.
      stream.onmessage = refresh
      // EventSource reconnects on its own. Nothing to do here but notice.
      stream.onerror = () => {
        online = false
      }
    } catch {
      /* no stream; the poll below still carries it */
    }
  }

  bc?.addEventListener('message', refresh)
  window.addEventListener('storage', (e) => e.key === KEY && refresh())
  setInterval(refresh, 60000)
}

// ── the fallback ────────────────────────────────────────────────────────────

function localList() {
  try {
    const raw = localStorage.getItem(KEY)
    const items = raw ? JSON.parse(raw) : []
    return Array.isArray(items) ? items : []
  } catch {
    return []
  }
}

/**
 * Hold a picture on this device until somebody can look at it.
 *
 * Deliberately few: these are data URLs, a third larger than the bytes they carry, against a
 * quota of about 5MB. Keeping two dozen of them was the reason the old wall silently dropped
 * the oldest pictures while claiming to show twenty-four.
 */
function keepLocally({ image, levels, shownHue }) {
  const entry = { id: newId(), image, levels, shownHue, ts: Date.now() }
  let items = [entry, ...localList()].slice(0, MAX_LOCAL)

  while (items.length) {
    try {
      localStorage.setItem(KEY, JSON.stringify(items))
      break
    } catch {
      if (items.length === 1) break // one picture over quota: keep it in memory only
      items = items.slice(0, items.length - 1)
    }
  }
  return entry
}

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return String(Date.now()) + Math.random().toString(16).slice(2)
}
