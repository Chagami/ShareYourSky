// Being one screen of four.
//
// Shared by both gallery designs, because this half is the server's protocol and not a design
// choice: join the register, hold a hand of curated pictures nobody else has, say you are still
// here, and give them back on the way out. Two copies of it would drift out of step with
// server/gallery.js one at a time and only fail on a wall with four screens actually running.
//
// What each design does with the pictures is its own business and stays in its own file.

const API = 'api/gallery'
const BEAT = 12000

/**
 * Join the wall.
 *
 * If the server forgets us — it restarted, or we were away long enough to be declared gone and
 * have our pictures handed to somebody else — we sign in again on the next claim, and `onLost`
 * (if given) is told. The gallery gives none: what is on screen stays up and rolls over as usual,
 * which costs nothing, where a reload would rebuild the whole page.
 */
export function joinWall({ onLost, onTrouble } = {}) {
  let me = null

  /**
   * Take `want` pictures nobody else is holding.
   *
   * Joins the register the first time and only the first time. Asking again through `join` puts
   * a *second* screen on the register every call, each holding a hand of its own — which on a
   * wall that tops up as it goes empties a folder of thirty within minutes and leaves the real
   * screens with duplicates.
   */
  async function claim(want) {
    try {
      const first = !me
      const res = await fetch(`${API}/${first ? 'join' : 'more'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: me?.id, want: Math.max(0, want) }),
      })
      if (res.status === 404 && !first) {
        // Forgotten while we were away. Join again rather than asking a stranger for more.
        me = null
        return claim(want)
      }
      if (!res.ok) throw new Error(`${res.status}`)
      const body = await res.json()
      if (first) me = { id: body.id, slot: body.slot }
      return body.images ?? []
    } catch (err) {
      // No allocator: the design should still show something rather than a black screen.
      // Without the register this screen may duplicate its neighbours, which is worse than a
      // wall and better than nothing.
      me = null
      onTrouble?.(err)
      return []
    }
  }

  /**
   * Give one picture back and take another.
   *
   * `ar` asks for the same proportions in return. Both designs show pictures at their own shape
   * and crop nothing, so a replacement of a different shape moves whatever is around it.
   */
  async function swap(retire, ar) {
    if (!me) return null
    try {
      const res = await fetch(`${API}/swap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: me.id, retire, ar }),
      })
      if (res.status === 404) {
        me = null
        onLost?.()
        return null
      }
      return (await res.json()).image ?? null
    } catch {
      return null
    }
  }

  setInterval(async () => {
    if (!me) return
    try {
      const res = await fetch(`${API}/beat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: me.id }),
      })
      if (res.status === 404) {
        me = null // signed in again by the next claim
        onLost?.()
      }
    } catch {
      /* the wall keeps showing what it has */
    }
  }, BEAT)

  // Hand the pictures back on the way out rather than making the server wait us out.
  addEventListener('pagehide', () => {
    if (!me) return
    navigator.sendBeacon?.(
      `${API}/leave`,
      new Blob([JSON.stringify({ id: me.id })], { type: 'application/json' })
    )
  })

  /** Hand pictures back — they have scrolled off the wall and somebody else may as well have them. */
  function release(files) {
    if (!me || !files.length) return
    fetch(`${API}/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: me.id, files }),
    }).catch(() => {})
  }

  return {
    claim,
    swap,
    release,
    /** Which of the four this is. Used to stride differently through the visitors' pictures. */
    get slot() {
      return me?.slot ?? 0
    },
    get joined() {
      return !!me
    },
  }
}

/**
 * Which visitor's picture a screen should show in its nth community place.
 *
 * Place 0 is always the newest, on every screen — somebody who has just shared is being told to
 * go and look, and finding it should not depend on which of four monitors they walk to. Beyond
 * the newest, each screen strides by the number of screens, so no two agree.
 */
export function communityAt(list, slot, n, screens = 4) {
  if (!list.length) return null
  if (n === 0) return list[0]
  return list[1 + slot + (n - 1) * screens] ?? list[n % list.length] ?? null
}
