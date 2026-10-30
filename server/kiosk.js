// Out of kiosk mode and back, from the debug menu.
//
// A page cannot close the browser it is in, or take it out of full screen, so the kiosk can only
// be left by something outside it. The server is the one thing that is: it runs as the same
// account as the desktop, and the kiosk browser is that account's systemd user service.
//
//   POST api/kiosk { action: 'exit' }   stop the kiosk service, open the page in an ordinary
//                                       window — tabs, a close button, the developer tools
//   POST api/kiosk { action: 'enter' }  close that window and start the kiosk service again
//   POST api/kiosk/heartbeat            the kiosk page saying it is alive and still drawing
//
// Either way the answer goes back before anything is done, because the browser asking is the
// one about to be closed. What happened is in the server's journal: journalctl -u sharedsky.
//
// Set in scripts/exhibit.env if the kiosk was set up differently from the README:
//   SKY_KIOSK_UNIT     the user service that runs the kiosk          (sharedsky-kiosk)
//   SKY_KIOSK_PROFILE  the Firefox profile it uses                   (~/snap/firefox/common/kiosk-profile)
//   SKY_KIOSK_BROWSER  the browser                                   (/snap/bin/firefox)
//   SKY_KIOSK_URL      what the ordinary window opens                (http://localhost/)
//
// and how patient the heartbeat watchdog is, in seconds:
//   SKY_KIOSK_HEARTBEAT_TIMEOUT  silence before the browser is restarted      (120)
//   SKY_KIOSK_FIRST_BEAT_GRACE   for a browser that has never beaten at all   (300)
//   SKY_KIOSK_RESTART_GAP        the least time between two restarts          (600)
//   SKY_KIOSK_HEARTBEAT_CHECK    how often it looks                           (15)
//   SKY_KIOSK_EXIT_PAUSE         out of kiosk mode this long, watch again     (7200)
//
// No authentication, for the same reason as the rest of the server: a LAN exhibit with no route
// in from outside. The worst a stranger on that network can do here is take the kiosk out of
// full screen.

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'

const UNIT = process.env.SKY_KIOSK_UNIT || 'sharedsky-kiosk'
// The ordinary window gets a unit of its own, so it can be found and closed again.
const WINDOW_UNIT = `${UNIT}-window`
const PROFILE = process.env.SKY_KIOSK_PROFILE || `${homedir()}/snap/firefox/common/kiosk-profile`
const BROWSER = process.env.SKY_KIOSK_BROWSER || '/snap/bin/firefox'
const PAGE = process.env.SKY_KIOSK_URL || 'http://localhost/'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const seconds = (name, fallback) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback) * 1000

// ── the heartbeat watchdog ──────────────────────────────────────────────────
//
// The kiosk browser can stop working without stopping: in October the graphics chip hung inside
// Firefox again and again, and a hang like that can leave the picture frozen or blank while every
// process is still running, so nothing that watches processes ever notices. So the page itself
// reports in, every few seconds, but only while it is still managing to draw (see main.js) — and
// when the reports stop, the browser is restarted.
//
// Only the kiosk counts. It opens http://localhost/, so a report from anywhere but this machine —
// a visitor's tablet, a laptop on the admin page — is ignored, or one of those could keep a dead
// kiosk looking alive. It stands back while the kiosk has been taken out of full screen from the
// debug menu, and leaves a browser alone that was stopped on purpose.
const BEAT_TIMEOUT = seconds('SKY_KIOSK_HEARTBEAT_TIMEOUT', 120)
const FIRST_BEAT_GRACE = seconds('SKY_KIOSK_FIRST_BEAT_GRACE', 300)
const RESTART_GAP = seconds('SKY_KIOSK_RESTART_GAP', 600)
// Out of kiosk mode for troubleshooting is a pause, not a switch-off: somebody who forgets to go
// back to it still gets a watched kiosk again after this.
const EXIT_PAUSE = seconds('SKY_KIOSK_EXIT_PAUSE', 7200)
const BEAT_CHECK = seconds('SKY_KIOSK_HEARTBEAT_CHECK', 15)

const beats = {
  last: null, // the kiosk's last report, ms since the epoch
  since: Date.now(), // when the watch began: server start, or the last restart
  restartedAt: 0,
  exited: 0, // when it was taken out of kiosk mode from the debug menu; 0 while it is in it
  restarts: 0,
}

const fromThisMachine = (req) => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket?.remoteAddress ?? '')

async function checkBeats() {
  const now = Date.now()
  if (beats.exited) {
    if (now - beats.exited < EXIT_PAUSE) return
    console.log(`[kiosk] watchdog: out of kiosk mode for ${Math.round((now - beats.exited) / 60000)} minutes — watching again`)
    Object.assign(beats, { exited: 0, last: null, since: now })
    return
  }
  const quiet = now - (beats.last ?? beats.since)
  if (quiet < (beats.last ? BEAT_TIMEOUT : FIRST_BEAT_GRACE)) return
  if (now - beats.restartedAt < RESTART_GAP) return

  // What the browser's service says it is doing. No answer at all means there is no desktop
  // session to run it in — the session watchdog's business, not this one's.
  const state = await run('systemctl', ['--user', 'is-active', UNIT], { ok: true })
  if (!state) return
  const why = beats.last ? `no heartbeat for ${Math.round(quiet / 1000)}s` : `never a heartbeat in ${Math.round(quiet / 1000)}s`
  beats.restartedAt = now
  beats.since = now
  beats.last = null
  try {
    if (state === 'active' || state === 'activating') {
      console.log(`[kiosk] watchdog: ${why} — restarting the kiosk browser`)
      await run('systemctl', ['--user', 'restart', UNIT])
    } else if (state === 'failed') {
      console.log(`[kiosk] watchdog: ${why}, and the browser had failed — starting it again`)
      await run('systemctl', ['--user', 'reset-failed', UNIT], { ok: true })
      await run('systemctl', ['--user', 'start', UNIT])
    } else {
      // Stopped, by somebody, on purpose. Not this watchdog's place to overrule them.
      console.log(`[kiosk] watchdog: ${why}, but the browser is ${state} — leaving it`)
      return
    }
    beats.restarts++
  } catch (err) {
    console.error(`[kiosk] watchdog: restart failed: ${err.message}`)
  }
}

let watching = false
function watchBeats() {
  if (watching || process.platform !== 'linux') return
  watching = true
  setInterval(() => checkBeats().catch((err) => console.error(`[kiosk] watchdog: ${err.message}`)), BEAT_CHECK).unref()
}

/**
 * Run a command against the desktop account's own systemd.
 *
 * The server is a system service, so it has none of the session's environment, and `systemctl
 * --user` cannot find the session's manager without being told where it is.
 */
function run(cmd, args, { ok = false } = {}) {
  const uid = process.getuid()
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
  }
  return new Promise((done, fail) => {
    execFile(cmd, args, { env, timeout: 20000 }, (err, stdout, stderr) => {
      if (err && !ok) fail(new Error(`${cmd} ${args.join(' ')}: ${(stderr || err.message).trim()}`))
      else done(String(stdout).trim())
    })
  })
}

/**
 * Wait for every browser on the kiosk's profile to be gone, and make sure of it.
 *
 * Stopping a unit is not always enough. Snap moves Firefox into a scope of its own, out of the
 * unit that started it, and a second Firefox will not open on a profile the first still holds.
 */
async function freeProfile() {
  for (let i = 0; i < 25; i++) {
    const left = await run('pgrep', ['-f', '--', `--profile ${PROFILE}`], { ok: true })
    if (!left) return
    if (i === 10) await run('pkill', ['-f', '--', `--profile ${PROFILE}`], { ok: true })
    if (i === 20) await run('pkill', ['-9', '-f', '--', `--profile ${PROFILE}`], { ok: true })
    await sleep(200)
  }
}

const ACTIONS = {
  async exit() {
    beats.exited = Date.now()
    await run('systemctl', ['--user', 'stop', UNIT])
    await run('systemctl', ['--user', 'stop', WINDOW_UNIT], { ok: true })
    await freeProfile()
    await run('systemd-run', ['--user', '--collect', `--unit=${WINDOW_UNIT}`, BROWSER, '--new-instance', '--profile', PROFILE, PAGE])
  },
  async enter() {
    await run('systemctl', ['--user', 'stop', WINDOW_UNIT], { ok: true })
    await freeProfile()
    await run('systemctl', ['--user', 'start', UNIT])
    // A fresh browser, and a fresh watch: it gets the first-beat grace, not the short timeout.
    Object.assign(beats, { exited: 0, last: null, since: Date.now() })
  },
}

export function kioskControl() {
  const json = (res, code, body) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  async function handle(req, res, next) {
    const path = new URL(req.url, 'http://x').pathname.replace(/^\/+/, '')

    if (path === 'api/kiosk/heartbeat') {
      if (req.method !== 'POST') return json(res, 405, { error: `${req.method} not allowed here` })
      req.resume() // nothing in the body is needed
      if (fromThisMachine(req)) beats.last = Date.now()
      res.statusCode = 204
      return res.end()
    }

    if (path !== 'api/kiosk') return next()
    if (req.method !== 'POST') return json(res, 405, { error: `${req.method} not allowed here` })

    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 1024) return json(res, 413, { error: 'body too large' })
    }
    const action = (() => {
      try {
        return JSON.parse(body)?.action
      } catch {
        return null
      }
    })()
    if (!Object.hasOwn(ACTIONS, action)) return json(res, 400, { error: 'action must be exit or enter' })

    // Asked before answering, so a machine where this cannot work says so to the button rather
    // than to a journal nobody is reading: the dev machine, or a kiosk set up some other way.
    if (process.platform !== 'linux') return json(res, 501, { error: 'only on the exhibit machine' })
    try {
      await run('systemctl', ['--user', 'cat', UNIT])
    } catch (err) {
      return json(res, 500, { error: `no ${UNIT} user service reachable — ${err.message}` })
    }

    json(res, 202, { ok: true, action })
    // A moment for the answer to reach the browser before it is closed.
    setTimeout(() => {
      ACTIONS[action]()
        .then(() => console.log(`[kiosk] ${action}: done`))
        .catch((err) => console.error(`[kiosk] ${action} failed: ${err.message}`))
    }, 300)
  }

  // Braces, not an expression body — see the same note in answers.js and wall.js.
  const install = (server) => {
    server.middlewares.use((req, res, next) => handle(req, res, next))
    watchBeats()
  }

  return {
    name: 'share-your-sky-kiosk',
    configureServer: install,
    configurePreviewServer: install,
  }
}
