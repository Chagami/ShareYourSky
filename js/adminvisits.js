// The admin page's Visitors view: when photos are taken, how each turn ended, and how many people
// opened the take-home code. Drawn from api/visit (server/visits.js), one row per turn.
//
// Times are binned by this browser's clock, which on the exhibit's own network is the exhibit's.
// Plain SVG, no library: three charts and a row of numbers do not need one.

const OUTCOME_LABEL = { shared: 'Shared', declined: 'Didn’t share', abandoned: 'Didn’t finish' }
// Stack order, bottom up, and the legend's order. Colour follows the outcome, never its rank.
const STACK = ['shared', 'declined', 'abandoned']
const SLOT_MIN = 15
const SLOTS = (24 * 60) / SLOT_MIN
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// Monday first: a week at a museum reads Monday to Sunday.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

const $ = (id) => document.getElementById(id)
const SVG = 'http://www.w3.org/2000/svg'
const svgEl = (name, attrs = {}) => {
  const el = document.createElementNS(SVG, name)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}

let visits = [] // { at: Date, outcome, downloaded, past, slot, day, dayKey, monthKey }
const filter = { month: 'all', days: new Set(DAY_ORDER), measure: 'total' }

// ── data ────────────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0')
const dayKeyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const monthKeyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`

async function load() {
  const res = await fetch('api/visit', { cache: 'no-store' })
  if (!res.ok) throw new Error(`the visit log answered ${res.status}`)
  const body = await res.json()
  // `past`: rebuilt from the answers log, from before the kiosk logged visits (server/visits.js).
  // Those say shared or not, nothing about downloads, and nobody who left before the question.
  visits = (body.rows ?? []).map(([taken, o, dl, past]) => {
    const at = new Date(taken)
    return {
      at,
      outcome: body.outcomes[o],
      downloaded: dl === 1,
      past: past === 1,
      slot: at.getHours() * (60 / SLOT_MIN) + Math.floor(at.getMinutes() / SLOT_MIN),
      day: at.getDay(),
      dayKey: dayKeyOf(at),
      monthKey: monthKeyOf(at),
    }
  })
}

function chosen() {
  return visits.filter((v) => (filter.month === 'all' || v.monthKey === filter.month) && filter.days.has(v.day))
}

// ── formatting ──────────────────────────────────────────────────────────────

function slotLabel(slot, { short = false } = {}) {
  const mins = slot * SLOT_MIN
  const h = Math.floor(mins / 60)
  const m = mins % 60
  const h12 = h % 12 || 12
  const ampm = h < 12 ? 'AM' : 'PM'
  return short ? (m ? `${h12}:${pad2(m)}` : `${h12} ${ampm}`) : `${h12}:${pad2(m)} ${ampm}`
}
const slotRange = (slot) => `${slotLabel(slot)} – ${slotLabel(slot + 1)}`
const monthName = (key) => {
  const [y, m] = key.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}
const dateName = (key, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts)
}
const pct = (n, of) => (of ? `${Math.round((100 * n) / of)}%` : '–')
function num(v) {
  if (filter.measure === 'total') return String(v)
  return v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2)
}

// ── the filters ─────────────────────────────────────────────────────────────

function buildFilters() {
  const months = [...new Set(visits.map((v) => v.monthKey))].sort()
  const first = visits.length ? visits.reduce((a, v) => (v.at < a ? v.at : a), visits[0].at) : null
  const sel = $('vMonth')
  const keep = filter.month
  sel.replaceChildren(
    new Option(first ? `All time (since ${first.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })})` : 'All time', 'all'),
    ...months.map((k) => new Option(monthName(k), k))
  )
  filter.month = months.includes(keep) ? keep : 'all'
  sel.value = filter.month

  const box = $('vDays')
  box.replaceChildren(
    ...DAY_ORDER.map((d) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'chip' + (filter.days.has(d) ? ' on' : '')
      b.textContent = DAYS[d]
      b.setAttribute('aria-pressed', filter.days.has(d))
      b.addEventListener('click', () => {
        // Never none: an empty chart reads as "nobody came", not "you filtered everything out".
        if (filter.days.has(d) && filter.days.size === 1) return
        filter.days.has(d) ? filter.days.delete(d) : filter.days.add(d)
        b.classList.toggle('on', filter.days.has(d))
        b.setAttribute('aria-pressed', filter.days.has(d))
        draw()
      })
      return b
    })
  )
}

function wireFilters() {
  $('vMonth').addEventListener('change', (e) => {
    filter.month = e.target.value
    draw()
  })
  $('vAllDays').addEventListener('click', () => {
    filter.days = new Set(DAY_ORDER)
    buildFilters()
    draw()
  })
  for (const b of document.querySelectorAll('#vMeasure button')) {
    b.addEventListener('click', () => {
      filter.measure = b.dataset.measure
      document.querySelectorAll('#vMeasure button').forEach((x) => x.setAttribute('aria-pressed', x === b))
      draw()
    })
  }
}

// ── drawing ─────────────────────────────────────────────────────────────────

function draw() {
  const rows = chosen()
  const openDays = new Set(rows.map((v) => v.dayKey)).size
  // "Average per day" is per day the exhibit was used: a closed Monday is not a quiet one.
  const per = filter.measure === 'avg' && openDays ? 1 / openDays : 1

  // Downloads are known only for the turns the kiosk logged itself.
  const logged = rows.filter((v) => !v.past)
  const loggedDays = new Set(logged.map((v) => v.dayKey)).size
  const perLogged = filter.measure === 'avg' && loggedDays ? 1 / loggedDays : 1

  tiles(rows, openDays, logged)
  note(rows)

  // Time-of-day range: the hours that saw a visitor, whole hours either side, 9 to 5 when empty.
  let lo = 9 * 4
  let hi = 17 * 4
  if (rows.length) {
    lo = Math.floor(Math.min(...rows.map((v) => v.slot)) / 4) * 4
    hi = Math.ceil((Math.max(...rows.map((v) => v.slot)) + 1) / 4) * 4
    if (hi - lo < 16) hi = Math.min(SLOTS, lo + 16)
  }
  const slots = []
  for (let s = lo; s < hi; s++) slots.push(s)

  const bySlot = new Map(slots.map((s) => [s, { shared: 0, declined: 0, abandoned: 0, downloaded: 0, sharedLogged: 0 }]))
  for (const v of rows) {
    const c = bySlot.get(v.slot)
    c[v.outcome]++
    if (v.downloaded) c.downloaded++
    if (!v.past && v.outcome === 'shared') c.sharedLogged++
  }
  const avgNote = filter.measure === 'avg' ? ` · average per day, over ${openDays} day${openDays === 1 ? '' : 's'} with visitors` : ''

  columns($('vWhen'), {
    keys: slots,
    stack: STACK,
    value: (s, k) => bySlot.get(s)[k] * per,
    label: (s) => (s % 4 === 0 ? slotLabel(s, { short: true }) : ''),
    tip: (s) => slotRange(s),
    empty: !rows.length,
  })
  $('vWhenSub').textContent = `Photos taken in each 15 minutes of the day${avgNote}`
  table($('vWhenTable'), slots.filter((s) => STACK.some((k) => bySlot.get(s)[k])), {
    head: ['Time', ...STACK.map((k) => OUTCOME_LABEL[k]), 'Total'],
    row: (s) => {
      const c = bySlot.get(s)
      const vals = STACK.map((k) => c[k] * per)
      return [slotRange(s), ...vals.map(num), num(vals.reduce((a, b) => a + b, 0))]
    },
  })

  columns($('vDownloads'), {
    keys: slots,
    stack: ['downloaded'],
    value: (s) => bySlot.get(s).downloaded * perLogged,
    label: (s) => (s % 4 === 0 ? slotLabel(s, { short: true }) : ''),
    tip: (s) => slotRange(s),
    extra: (s) => {
      const c = bySlot.get(s)
      return c.sharedLogged ? `${pct(c.downloaded, c.sharedLogged)} of those who shared` : ''
    },
    empty: !logged.length,
  })
  const since = logStart()
  const loggedNote = filter.measure === 'avg' ? ` · average per day, over ${loggedDays} day${loggedDays === 1 ? '' : 's'}` : ''
  $('vDownloadsSub').textContent = `Visitors who opened the take-home QR code, by when their photo was taken${since ? ` · counted since ${since}` : ''}${loggedNote}`
  table($('vDownloadsTable'), slots.filter((s) => bySlot.get(s).downloaded), {
    head: ['Time', 'Opened the code', 'Shared'],
    row: (s) => [slotRange(s), num(bySlot.get(s).downloaded * perLogged), num(bySlot.get(s).sharedLogged * perLogged)],
  })

  // Every day, as a continuum. Days the filter keeps are all shown, visitors or not, so a gap in
  // the bars is a day nobody came rather than a day that went missing.
  const dayKeys = []
  if (rows.length) {
    const first = new Date(Math.min(...rows.map((v) => v.at)))
    const last = new Date(Math.max(...rows.map((v) => v.at)))
    for (let d = new Date(first.getFullYear(), first.getMonth(), first.getDate()); d <= last; d.setDate(d.getDate() + 1)) {
      if (filter.days.has(d.getDay())) dayKeys.push(dayKeyOf(d))
    }
  }
  const byDay = new Map(dayKeys.map((k) => [k, { shared: 0, declined: 0, abandoned: 0 }]))
  for (const v of rows) byDay.get(v.dayKey)[v.outcome]++
  columns($('vDaily'), {
    keys: dayKeys,
    stack: STACK,
    value: (k, o) => byDay.get(k)[o],
    label: (k) => dateName(k, { month: 'short', day: 'numeric' }),
    tip: (k) => dateName(k, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    empty: !rows.length,
    counts: true,
  })
  $('vDailySub').textContent = 'Photos taken each day, every day in the period'
  table($('vDailyTable'), dayKeys.filter((k) => STACK.some((o) => byDay.get(k)[o])), {
    head: ['Day', ...STACK.map((k) => OUTCOME_LABEL[k]), 'Total'],
    row: (k) => {
      const c = byDay.get(k)
      return [dateName(k), ...STACK.map((o) => c[o]), STACK.reduce((a, o) => a + c[o], 0)]
    },
  })
}

/** When the kiosk began logging visits itself, if there is history from before it. */
function logStart() {
  if (!visits.some((v) => v.past)) return null
  const first = visits.find((v) => !v.past)
  return first ? first.at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null
}

/** Says which part of the selection is rebuilt from the answers log, and what that leaves out. */
function note(rows) {
  const el = $('vNote')
  const past = rows.filter((v) => v.past)
  el.hidden = !past.length
  if (!past.length) return
  const last = past.at(-1).at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  el.textContent =
    `Visits up to ${last} are rebuilt from the answers log, which the exhibit kept from the start: ` +
    'everyone who reached “Is this image real?”, and whether they shared. It cannot tell “Don’t share” ' +
    'from walking away at that question (both count as didn’t share), it misses anyone who left ' +
    'before it, and it times each visit when they answered, a minute or two after the photo. ' +
    'Downloads were not recorded then.'
}

function tiles(rows, openDays, logged) {
  const n = rows.length
  const count = (o) => rows.filter((v) => v.outcome === o).length
  const shared = count('shared')
  const sharedLogged = logged.filter((v) => v.outcome === 'shared').length
  const dl = logged.filter((v) => v.downloaded).length
  const items = [
    ['Photos taken', n, openDays ? `${(n / openDays).toFixed(1)} a day, over ${openDays} day${openDays === 1 ? '' : 's'}` : 'none yet'],
    ['Shared', shared, pct(shared, n) + ' of photos', 'shared'],
    ['Didn’t share', count('declined'), pct(count('declined'), n) + ' of photos', 'declined'],
    ['Didn’t finish', count('abandoned'), pct(count('abandoned'), n) + ' of photos', 'abandoned'],
    ['Opened the download code', dl, pct(dl, sharedLogged) + ' of those who shared' + (logStart() ? `, since ${logStart()}` : ''), 'downloaded'],
  ]
  $('vTiles').replaceChildren(
    ...items.map(([label, value, sub, key]) => {
      const t = document.createElement('div')
      t.className = 'vtile'
      t.innerHTML = `<span class="vtile-label">${key ? `<i class="key k-${key}"></i>` : ''}</span><span class="vtile-value"></span><span class="vtile-sub"></span>`
      t.querySelector('.vtile-label').append(label)
      t.querySelector('.vtile-value').textContent = value.toLocaleString()
      t.querySelector('.vtile-sub').textContent = sub
      return t
    })
  )
}

/** Round up to a tidy axis maximum, and the step between its gridlines. */
function niceScale(max, { counts }) {
  if (max <= 0) return { top: counts ? 4 : 1, step: counts ? 1 : 0.25 }
  const rough = max / 4
  const mag = 10 ** Math.floor(Math.log10(rough))
  let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough)
  if (counts || filter.measure === 'total') step = Math.max(1, Math.ceil(step))
  return { top: Math.ceil(max / step) * step, step }
}

/**
 * Columns, stacked when there is more than one series. Thin marks, a 2px surface gap between
 * stacked segments, 4px rounded tops, square at the baseline; a tooltip on every column.
 */
function columns(host, { keys, stack, value, label, tip, extra, empty, counts = false }) {
  const plot = host.querySelector('.vplot')
  const W = Math.max(320, plot.clientWidth || 800)
  const H = 260
  const M = { top: 12, right: 8, bottom: 28, left: 40 }
  const iw = W - M.left - M.right
  const ih = H - M.top - M.bottom
  const totals = keys.map((k) => stack.reduce((a, s) => a + value(k, s), 0))
  const { top, step } = niceScale(Math.max(0, ...totals), { counts: counts || filter.measure === 'total' })
  const y = (v) => M.top + ih - (v / top) * ih
  const band = keys.length ? iw / keys.length : iw
  const bw = Math.max(1, Math.min(24, band - Math.min(4, band * 0.3)))

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' })
  const fmt = (v) => (counts || filter.measure === 'total' ? String(Math.round(v)) : Number(v.toFixed(2)).toString())
  for (let v = 0; v <= top + 1e-9; v += step) {
    svg.append(svgEl('line', { x1: M.left, x2: W - M.right, y1: y(v), y2: y(v), class: v ? 'grid' : 'base' }))
    const t = svgEl('text', { x: M.left - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' })
    t.textContent = fmt(v)
    svg.append(t)
  }
  // Labels where they fit: a candidate closer than this to the last one drawn is skipped, so a
  // narrow screen gets fewer of them rather than a pile-up.
  const LABEL_GAP = 58
  let lastLabel = -Infinity
  keys.forEach((k, i) => {
    const text = label(k, i)
    const cx = M.left + band * i + band / 2
    if (!text || cx - lastLabel < LABEL_GAP) return
    lastLabel = cx
    const t = svgEl('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'tick' })
    t.textContent = text
    svg.append(t)
  })

  const tipEl = host.querySelector('.vtip')
  keys.forEach((k, i) => {
    const x = M.left + band * i + (band - bw) / 2
    const segs = stack.map((s) => ({ s, v: value(k, s) })).filter((p) => p.v > 0)
    let base = 0
    segs.forEach(({ s, v }, j) => {
      const y0 = y(base)
      const y1 = y(base + v)
      base += v
      // The gap belongs to the segment above: every segment but the first gives up 2px at its foot.
      const bottom = j === 0 ? y0 : y0 - 2
      const h = bottom - y1
      if (h <= 0.5) return
      const r = j === segs.length - 1 ? Math.min(4, h, bw / 2) : 0
      svg.append(svgEl('path', { d: roundTop(x, y1, bw, h, r), class: `mark k-${s}` }))
    })
    // The hover target is the whole slot, top to bottom: a thin column is a poor thing to aim at.
    const hit = svgEl('rect', { x: M.left + band * i, y: M.top, width: band, height: ih, class: 'hit' })
    const show = () => {
      const lines = stack.map((s) => `<div><i class="key k-${s}"></i>${s === 'downloaded' ? 'Opened the code' : OUTCOME_LABEL[s]}<b>${num(value(k, s))}</b></div>`)
      if (stack.length > 1) lines.push(`<div class="sum">Total<b>${num(totals[i])}</b></div>`)
      const more = extra?.(k)
      tipEl.innerHTML = `<div class="vtip-head"></div>${lines.join('')}${more ? `<div class="vtip-note"></div>` : ''}`
      tipEl.querySelector('.vtip-head').textContent = tip(k)
      if (more) tipEl.querySelector('.vtip-note').textContent = more
      tipEl.hidden = false
      const px = ((M.left + band * i + band / 2) / W) * plot.clientWidth
      const left = Math.min(Math.max(0, px - tipEl.offsetWidth / 2), plot.clientWidth - tipEl.offsetWidth)
      tipEl.style.left = `${left}px`
      hit.classList.add('on')
    }
    const hide = () => {
      tipEl.hidden = true
      hit.classList.remove('on')
    }
    hit.addEventListener('pointerenter', show)
    hit.addEventListener('pointerleave', hide)
    svg.append(hit)
  })
  if (empty) {
    const t = svgEl('text', { x: W / 2, y: M.top + ih / 2, 'text-anchor': 'middle', class: 'empty' })
    t.textContent = 'No visits recorded for this selection yet'
    svg.append(t)
  }
  plot.replaceChildren(svg)
}

function roundTop(x, y, w, h, r) {
  return r
    ? `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
    : `M${x},${y + h}V${y}H${x + w}V${y + h}Z`
}

function table(host, keys, { head, row }) {
  const t = document.createElement('table')
  const thead = t.createTHead().insertRow()
  head.forEach((h) => (thead.insertCell().outerHTML = `<th>${h}</th>`))
  const tbody = t.createTBody()
  for (const k of keys) {
    const r = tbody.insertRow()
    row(k).forEach((v) => (r.insertCell().textContent = v))
  }
  if (!keys.length) tbody.insertRow().insertCell().textContent = 'Nothing yet'
  host.replaceChildren(t)
}

// ── starting up ─────────────────────────────────────────────────────────────

let ready = false

/** Called by admin.js when the Visitors view is shown. */
export async function showVisits({ arm, say }) {
  if (!ready) {
    ready = true
    wireFilters()
    arm($('vClear'), 'Clear visits', 'Press again — download it first', async () => {
      const res = await fetch('api/visit', { method: 'DELETE' })
      if (!res.ok) throw new Error(`the visit log answered ${res.status}`)
      await refreshVisits(say)
    })
    let pending = 0
    addEventListener('resize', () => {
      cancelAnimationFrame(pending)
      pending = requestAnimationFrame(() => !$('visits').hidden && draw())
    })
  }
  await refreshVisits(say)
}

export async function refreshVisits(say) {
  try {
    await load()
    say(null)
  } catch (err) {
    visits = []
    say(`Cannot read the visit log — ${err.message}.`)
  }
  $('vClear').disabled = !visits.length
  buildFilters()
  draw()
}
