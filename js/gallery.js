// Gallery wall. Renders whatever is in the store and re-renders the moment the
// interaction screen publishes something, so a visitor can walk from one display to the
// other and find their image already there.

import { CHANNELS } from './imaging.js'
import { list, subscribe } from './store.js'

const grid = document.getElementById('grid')
const empty = document.getElementById('empty')

let firstPaint = true
let seen = new Set()

function render(items) {
  empty.hidden = items.length > 0
  grid.replaceChildren(...items.map(piece))
  seen = new Set(items.map((item) => item.id))
  firstPaint = false
}

function piece(item) {
  const root = document.createElement('figure')
  root.className = 'piece'
  // Only animate arrivals, not the whole wall on load or on an unrelated change.
  if (!firstPaint && !seen.has(item.id)) root.classList.add('fresh')

  const img = document.createElement('img')
  img.src = item.image
  img.alt = 'A visitor’s composite'
  root.append(img)

  const meta = document.createElement('figcaption')
  meta.className = 'piece-meta'

  const mix = document.createElement('div')
  mix.className = 'mix'
  CHANNELS.forEach((channel, i) => {
    const row = document.createElement('div')
    row.className = 'mix-row'
    row.style.setProperty('--acc', channel.accent)
    row.title = `${channel.label} ${Math.round((item.weights?.[i] ?? 1) * 100)}%`
    const bar = document.createElement('i')
    // Weights run 0–2, so 100% of the bar means the maximum the sliders allow.
    bar.style.width = `${Math.min(100, ((item.weights?.[i] ?? 1) / 2) * 100)}%`
    row.append(bar)
    mix.append(row)
  })

  const when = document.createElement('span')
  when.className = 'piece-when'
  when.dataset.ts = item.ts
  when.textContent = ago(item.ts)

  meta.append(mix, when)
  root.append(meta)
  return root
}

function ago(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (!Number.isFinite(mins) || mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hr ago`
  return `${Math.floor(hours / 24)} d ago`
}

subscribe(render)
render(list())

// Keep the timestamps honest on a wall that may sit untouched for hours.
setInterval(() => {
  grid.querySelectorAll('.piece-when').forEach((node) => {
    node.textContent = ago(Number(node.dataset.ts))
  })
}, 60000)
