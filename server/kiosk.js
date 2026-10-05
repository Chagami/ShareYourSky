// Out of kiosk mode and back, from the debug menu.
//
// A page cannot close the browser it is in, or take it out of full screen, so the kiosk can only
// be left by something outside it. The server is the one thing that is: it runs as the same
// account as the desktop, and the kiosk browser is that account's systemd user service.
//
//   POST api/kiosk { action: 'exit' }   stop the kiosk service, open the page in an ordinary
//                                       window — tabs, a close button, the developer tools
//   POST api/kiosk { action: 'enter' }  close that window and start the kiosk service again
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
    await run('systemctl', ['--user', 'stop', UNIT])
    await run('systemctl', ['--user', 'stop', WINDOW_UNIT], { ok: true })
    await freeProfile()
    await run('systemd-run', ['--user', '--collect', `--unit=${WINDOW_UNIT}`, BROWSER, '--new-instance', '--profile', PROFILE, PAGE])
  },
  async enter() {
    await run('systemctl', ['--user', 'stop', WINDOW_UNIT], { ok: true })
    await freeProfile()
    await run('systemctl', ['--user', 'start', UNIT])
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
  }

  return {
    name: 'share-your-sky-kiosk',
    configureServer: install,
    configurePreviewServer: install,
  }
}
