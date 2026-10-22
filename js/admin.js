// The photos page: everything that has ever been shared, and a way to take one down.
//
// Not part of the exhibit and not linked from it. It talks to the same store the wall does
// (see server/wall.js), but asks for `?all=1` — the wall shows the newest two dozen, and the
// picture somebody wants removed is as likely to be one that has already scrolled off it.
//
// Deletion is permanent and there is no undo, so every destructive button asks twice. Not with
// a modal: an operator standing at a kiosk dismisses those without reading them. The button
// itself changes to say exactly what is about to happen and has to be pressed again.

const API = 'api/wall'

const grid = document.getElementById('grid')
const countEl = document.getElementById('count')
const noteEl = document.getElementById('note')
const refreshBtn = document.getElementById('refresh')
const selectAllBtn = document.getElementById('selectAll')
const removeSelBtn = document.getElementById('removeSel')
const clearAllBtn = document.getElementById('clearAll')
const clearAnswersBtn = document.getElementById('clearAnswers')
const downloadAllLink = document.getElementById('downloadAll')
const downloadSelBtn = document.getElementById('downloadSel')

let items = []
let selected = new Set()
// How many of them the wall is currently showing. Taken from the server's answer rather than
// hardcoded here — two copies of that number would eventually disagree, and this page would be
// the one lying about which photos a visitor can actually see.
let onWall = 0

// ── talking to the store ────────────────────────────────────────────────────

async function load() {
  try {
    const res = await fetch(`${API}?all=1`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`the store answered ${res.status}`)
    const body = await res.json()
    items = body.items ?? []
    // Anything selected that is no longer here was removed by somebody else meanwhile.
    selected = new Set([...selected].filter((id) => items.some((i) => i.id === id)))
    say(null)
    render(body)
  } catch (err) {
    items = []
    render(null)
    say(
      `Cannot reach the store at ${location.origin}/${API} — ${err.message}. ` +
        'This page has to be served by the machine the exhibit runs on.'
    )
  }
}

async function removeOne(id) {
  const res = await fetch(`${API}/img/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`${id.slice(0, 8)}: ${res.status}`)
}

// ── drawing it ──────────────────────────────────────────────────────────────

function render(body) {
  onWall = body?.onWall ?? 0
  grid.replaceChildren(...items.map(card))
  syncTools()

  if (!body) {
    countEl.textContent = 'No connection to the store'
    return
  }
  countEl.textContent = items.length
    ? `${items.length} photo${items.length === 1 ? '' : 's'} · ` +
      `${body.onWall} on the wall · ${size(body.bytes)} on disk`
    : 'Nothing has been shared yet'
}

function card(item) {
  const root = document.createElement('figure')
  root.className = 'shot' + (selected.has(item.id) ? ' picked' : '')
  root.dataset.id = item.id

  const img = document.createElement('img')
  img.src = item.image
  img.alt = ''
  img.loading = 'lazy' // a season's worth of photos should not all decode at once
  root.append(img)

  // The whole card is the selection target. An operator may well be doing this on the tablet,
  // and a checkbox in a corner is a poor thing to hit with a thumb.
  root.addEventListener('click', (e) => {
    if (e.target.closest('.shot-x, .shot-dl')) return
    selected.has(item.id) ? selected.delete(item.id) : selected.add(item.id)
    root.classList.toggle('picked', selected.has(item.id))
    syncTools()
  })

  const x = document.createElement('button')
  x.className = 'shot-x'
  x.type = 'button'
  x.title = 'Delete this photo'
  x.textContent = '×'
  arm(x, '×', 'Delete?', async () => {
    await removeOne(item.id)
    selected.delete(item.id)
    await load()
  })
  root.append(x)

  // This one picture, under a name that says when it was shared. A link, because a link is what
  // saves a file; same origin, so `download` is honoured.
  const dl = document.createElement('a')
  dl.className = 'shot-dl'
  dl.href = item.image
  dl.download = item.name ?? `${item.id}.jpg`
  dl.title = 'Download this photo'
  dl.setAttribute('aria-label', 'Download this photo')
  dl.textContent = '↓'
  root.append(dl)

  const meta = document.createElement('figcaption')
  meta.className = 'shot-meta'
  const when = document.createElement('span')
  when.textContent = stamp(item.ts)
  const where = document.createElement('span')
  const showing = items.indexOf(item) < onWall
  where.className = 'tag' + (showing ? ' on' : '')
  where.textContent = showing ? 'on the wall' : 'archived'
  meta.append(when, where)
  root.append(meta)

  return root
}

function syncTools() {
  const n = selected.size
  removeSelBtn.disabled = n === 0
  reset(removeSelBtn, n ? `Delete ${n} selected` : 'Delete selected')
  downloadSelBtn.disabled = n === 0
  downloadSelBtn.textContent = n ? `Download ${n} selected` : 'Download selected'
  // Nothing to download is a link that answers with an error page, so it is shown as off.
  downloadAllLink.classList.toggle('off', items.length === 0)
  selectAllBtn.textContent = n && n === items.length ? 'Select none' : 'Select all'
  ;[...grid.children].forEach((el) => el.classList.toggle('picked', selected.has(el.dataset.id)))
}

function say(message) {
  noteEl.hidden = !message
  noteEl.textContent = message ?? ''
}

// ── asking twice ────────────────────────────────────────────────────────────

/**
 * Make a button confirm itself.
 *
 * First press swaps the label for what is about to happen; second press does it. It reverts on
 * its own after a few seconds, so a button left half-pressed cannot be finished by somebody
 * walking past. A modal would be dismissed unread; a button that has visibly changed into a
 * warning is read, because it is the thing being pressed.
 */
function arm(button, idle, confirmLabel, run) {
  let armed = false
  let timer = 0
  // On the button rather than in this closure, because the resting label can change while the
  // button is armed — the selection count is in it. Captured here, a button that armed with
  // three photos picked would disarm back to "Delete selected" and lose the count.
  button.dataset.idle = idle

  const stand = () => {
    armed = false
    clearTimeout(timer)
    button.classList.remove('armed')
    button.textContent = button.dataset.idle
  }

  button.addEventListener('click', async (e) => {
    e.stopPropagation()
    if (!armed) {
      armed = true
      button.classList.add('armed')
      button.textContent = confirmLabel
      timer = setTimeout(stand, 4000)
      return
    }
    stand()
    // A class rather than `disabled`, which belongs to whoever decides whether this button has
    // anything to do — syncTools for the selection, syncAnswers for the count. Both of those
    // run inside run(), and a finally that put `disabled = false` back afterwards left the
    // button live and saying it had nothing left to delete.
    button.classList.add('working')
    try {
      await run()
    } catch (err) {
      say(`Could not delete: ${err.message}`)
    } finally {
      button.classList.remove('working')
    }
  })
}

/**
 * Change an armed button's resting label without disarming it.
 *
 * The selection count is in the label, and the list can change under it — but a button that is
 * mid-confirmation must keep saying so, or the next press deletes against a label that has
 * quietly become something else.
 */
function reset(button, idle) {
  button.dataset.idle = idle
  if (!button.classList.contains('armed')) button.textContent = idle
}

// ── the toolbar ─────────────────────────────────────────────────────────────

// The selection, as one zip. Sent as a form rather than fetched: the browser then treats the
// answer as the download it is, saving it as it arrives, instead of this page holding a season's
// photos in memory to hand over at the end.
downloadSelBtn.addEventListener('click', () => {
  if (!selected.size) return
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = `${API}/zip`
  form.hidden = true
  const ids = document.createElement('input')
  ids.type = 'hidden'
  ids.name = 'ids'
  ids.value = [...selected].join(',')
  form.append(ids)
  document.body.append(form)
  form.submit()
  form.remove()
})

refreshBtn.addEventListener('click', () => {
  load()
  syncAnswers()
})

selectAllBtn.addEventListener('click', () => {
  selected = selected.size === items.length ? new Set() : new Set(items.map((i) => i.id))
  syncTools()
})

arm(removeSelBtn, 'Delete selected', 'Press again to delete', async () => {
  const going = [...selected]
  const failed = []
  for (const id of going) {
    try {
      await removeOne(id)
    } catch (err) {
      failed.push(err.message)
    }
  }
  selected.clear()
  await load()
  say(failed.length ? `${going.length - failed.length} deleted; failed: ${failed.join(', ')}` : null)
})

arm(clearAllBtn, 'Delete everything', 'Press again — this cannot be undone', async () => {
  const res = await fetch(API, { method: 'DELETE' })
  if (!res.ok) throw new Error(`the store answered ${res.status}`)
  selected.clear()
  await load()
})

// ── the answers ─────────────────────────────────────────────────────────────
//
// A separate store with a separate button, because they are separate things: the pictures stay
// on disk after they scroll off the wall, and these are rows in a file that nothing else holds
// a copy of. Hence "download it first" rather than "this cannot be undone" — it is the same
// warning, but it names the thing to do about it, and the download is the button to its left.

/** How many answers are on file, for the button that throws them away. */
async function countAnswers() {
  try {
    const res = await fetch('api/answer/summary', { cache: 'no-store' })
    if (!res.ok) return null
    const totals = (await res.json())?.totals ?? {}
    return Object.values(totals).reduce((a, b) => a + b, 0)
  } catch {
    return null // the page still works without it; the button simply cannot count
  }
}

async function syncAnswers() {
  const n = await countAnswers()
  // Not `!n`: unreachable is not the same as empty, and a button that refuses to be pressed
  // because the count failed is worse than one that tries and reports what happened.
  clearAnswersBtn.disabled = n === 0
  reset(clearAnswersBtn, n === null ? 'Clear answers' : n === 0 ? 'No answers yet' : `Clear ${n} answers`)
}

arm(clearAnswersBtn, 'Clear answers', 'Press again — download it first', async () => {
  const res = await fetch('api/answer', { method: 'DELETE' })
  if (!res.ok) throw new Error(`the answers answered ${res.status}`)
  // Nothing to say: the button itself goes from "Clear 12 answers" to "No answers yet", which
  // is the confirmation, in the place the operator is already looking. The note beside it is
  // styled as a warning, and a warning that says the thing worked is a worse message than none.
  await syncAnswers()
})

syncAnswers()

// ── keeping up with the exhibit ─────────────────────────────────────────────

// The wall is being used while this page is open, so it should not go stale under the operator.
// Any message means something changed; re-reading the list is cheap.
if (typeof EventSource !== 'undefined') {
  try {
    new EventSource(`${API}/stream`).onmessage = load
  } catch {
    /* the reload button is always there */
  }
}

function stamp(ts) {
  const d = new Date(ts)
  return Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'unknown'
}

function size(bytes) {
  if (!bytes) return '0 KB'
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`
}

load()
