// The camera's exposure, from the debug menu.
//
// Firefox gives a page no say over a camera's exposure — it ignores the constraints Chrome would
// pass on — so this is done the way qv4l2 does it, with v4l2-ctl, by the server, which runs on the
// machine the camera is plugged into. Camera controls can be changed while another program has
// the camera open, so the viewfinder carries on throughout and shows the change as it happens.
//
//   GET  api/camera/exposure                  { device, mode: 'auto'|'manual', time: {min,max,value} }
//   POST api/camera/exposure { mode }         switch auto / manual, answers as GET does
//   POST api/camera/exposure { time }         set the exposure time, in the camera's own units
//
// The time is in the camera's units, which for UVC cameras is tenths of a millisecond. Names are
// read from the camera rather than assumed: kernels before 5.x call these exposure_auto and
// exposure_absolute, later ones auto_exposure and exposure_time_absolute, and the menu numbers
// for "manual" and "automatic" are whatever the camera says they are.
//
//   SKY_CAMERA_DEVICE  which camera, in scripts/exhibit.env   (/dev/video0)
//                      v4l2-ctl --list-devices says which is which
//
// No authentication, as with the rest of the server: the worst a stranger on the exhibit's
// network can do here is make the picture too dark or too bright until somebody sets it back.
// And like the camera's other settings, these are forgotten when it is unplugged or the machine
// restarts.

import { execFile } from 'node:child_process'

const DEVICE = process.env.SKY_CAMERA_DEVICE || '/dev/video0'

function v4l2(args) {
  return new Promise((done, fail) => {
    execFile('v4l2-ctl', ['-d', DEVICE, ...args], { timeout: 8000 }, (err, stdout, stderr) => {
      if (!err) return done(String(stdout))
      if (err.code === 'ENOENT') return fail(new Error('v4l2-ctl is not installed: sudo apt install v4l-utils'))
      fail(new Error((stderr || err.message).trim()))
    })
  })
}

/**
 * Every control the camera has, with its numbers and, for a menu, its choices.
 *
 *   auto_exposure 0x009a0901 (menu)   : min=0 max=3 default=3 value=3 (Aperture Priority Mode)
 *       1: Manual Mode
 *       3: Aperture Priority Mode
 *   exposure_time_absolute 0x009a0902 (int)    : min=1 max=5000 step=1 default=157 value=157
 */
async function controls() {
  const out = {}
  let last = null
  for (const line of (await v4l2(['--list-ctrls-menus'])).split('\n')) {
    const ctrl = line.match(/^\s*(\w+)\s+0x[0-9a-f]+\s+\((\w+)\)\s*:\s*(.*)$/i)
    if (ctrl) {
      const [, name, type, rest] = ctrl
      const nums = Object.fromEntries([...rest.matchAll(/(\w+)=(-?\d+)/g)].map(([, k, v]) => [k, Number(v)]))
      last = out[name] = { name, type, ...nums, menu: {} }
      continue
    }
    const item = line.match(/^\s*(\d+):\s*(.+?)\s*$/)
    if (item && last?.type === 'menu') last.menu[Number(item[1])] = item[2]
  }
  return out
}

/** The two controls that matter here, and which menu entries mean manual and automatic. */
async function exposure() {
  const all = await controls()
  const mode = all.auto_exposure ?? all.exposure_auto
  const time = all.exposure_time_absolute ?? all.exposure_absolute
  if (!mode || !time) throw new Error(`this camera (${DEVICE}) has no exposure controls`)
  const entries = Object.entries(mode.menu).map(([v, label]) => [Number(v), label])
  const manual = entries.find(([, label]) => /manual/i.test(label))?.[0] ?? 1
  // A UVC camera's automatic mode is usually called Aperture Priority. Any non-manual entry will do.
  const auto =
    entries.find(([, label]) => /aperture|auto/i.test(label) && !/manual/i.test(label))?.[0] ??
    entries.find(([v]) => v !== manual)?.[0] ??
    3
  return { mode, time, manual, auto }
}

async function state() {
  const { mode, time, manual } = await exposure()
  return {
    device: DEVICE,
    mode: mode.value === manual ? 'manual' : 'auto',
    time: { min: time.min, max: time.max, step: time.step || 1, value: time.value },
  }
}

export function cameraControl() {
  const json = (res, code, body) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  async function handle(req, res, next) {
    const path = new URL(req.url, 'http://x').pathname.replace(/^\/+/, '')
    if (path !== 'api/camera/exposure') return next()
    if (process.platform !== 'linux') return json(res, 501, { error: 'only on the exhibit machine' })

    try {
      if (req.method === 'GET') return json(res, 200, await state())
      if (req.method !== 'POST') return json(res, 405, { error: `${req.method} not allowed here` })

      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 1024) return json(res, 413, { error: 'body too large' })
      }
      let ask
      try {
        ask = JSON.parse(body)
      } catch {
        return json(res, 400, { error: 'expected JSON' })
      }

      const { mode, time, manual, auto } = await exposure()
      if (ask?.mode === 'auto' || ask?.mode === 'manual') {
        await v4l2(['-c', `${mode.name}=${ask.mode === 'manual' ? manual : auto}`])
      } else if (Number.isFinite(ask?.time)) {
        // A time only means something in manual; asking for one switches to it, as qv4l2 would
        // need doing by hand first.
        if (mode.value !== manual) await v4l2(['-c', `${mode.name}=${manual}`])
        const step = time.step || 1
        const value = Math.min(time.max, Math.max(time.min, Math.round(ask.time / step) * step))
        await v4l2(['-c', `${time.name}=${value}`])
      } else {
        return json(res, 400, { error: 'send { mode: "auto" | "manual" } or { time: number }' })
      }
      return json(res, 200, await state())
    } catch (err) {
      return json(res, 500, { error: String(err?.message ?? err) })
    }
  }

  // Braces, not an expression body — see the same note in answers.js and wall.js.
  const install = (server) => {
    server.middlewares.use((req, res, next) => handle(req, res, next))
  }

  return {
    name: 'share-your-sky-camera',
    configureServer: install,
    configurePreviewServer: install,
  }
}
