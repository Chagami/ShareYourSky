// Camera start-up with no on-screen picker.
//
// The earlier prototypes needed a camera selector because the exhibit PC has more than
// one video input (Filters/ hardcoded CAMERA_INDEX = 1). Rather than put a dropdown on a
// visitor-facing screen, the choice is a URL parameter on the kiosk shortcut:
//
//   index.html?cam=1          -> second video input, by order
//   index.html?cam=Logitech   -> first input whose label contains "Logitech"
//   index.html?cam=back       -> Android labels read "camera2 1, facing back", so this works
//
// With no parameter it prefers a front-facing camera, and otherwise takes whatever the browser
// hands over.
//
//   index.html?res=1080      never ask this camera for 4K
//   index.html?res=any       ask for nothing in particular
//   index.html?res=2560x1440 start the ladder there
//
// `?res=` is the knob for a camera that will not start at 4K, or starts and then sends no
// picture. See the ladder below.
//
// Worth knowing on a tablet: Android's permission prompt has no camera picker. Desktop Chrome
// lets you choose a device in the permission bubble; Android gives you Allow or Block and the
// page decides. So `?cam=` is the only way to choose there — and the way to find out what to
// put in it is the debug overlay, which lists every input with the index to use.

import { setInfo } from './perf.js'

/**
 * Write what this device is actually offering into the debug overlay.
 *
 * Android's permission prompt has no camera picker — desktop Chrome lets you choose a device in
 * the bubble, Android gives you Allow or Block and the page picks. So on a tablet the only way
 * to choose is `?cam=`, and the only way to know what to put there is to read the list off the
 * device. Labels stay blank until permission is granted, so this is worth calling twice.
 */
export async function reportCameras(activeTrack = null) {
  setInfo('secure', `${window.isSecureContext} · ${location.protocol}//${location.hostname}`)

  try {
    const perm = await navigator.permissions?.query({ name: 'camera' })
    if (perm) setInfo('permission', perm.state)
  } catch {
    setInfo('permission', 'not reportable in this browser')
  }

  if (activeTrack) {
    const st = activeTrack.getSettings()
    setInfo('using', `${activeTrack.label || '(unlabelled)'}
${st.width}x${st.height} facing ${st.facingMode ?? '?'}`)
  }

  try {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
    const activeId = activeTrack?.getSettings().deviceId
    setInfo(
      'cameras',
      inputs.length
        ? inputs
            .map((d, i) => `?cam=${i}  ${d.label || '(label hidden until allowed)'}${d.deviceId === activeId ? '  <- in use' : ''}`)
            .join('\n')
        : 'none enumerated'
    )
  } catch (err) {
    setInfo('cameras', `enumerate failed: ${err.name}`)
  }
}

// How long to wait for one request before deciding it is not going to answer.
//
// Generous, and it has to be. A 4K sensor negotiating its first open on Windows routinely takes
// ten seconds and has been seen to take longer; the ten seconds this used to allow turned every
// slow camera into a broken one.
const OPEN_TIMEOUT = 16000

// And how long to wait for a request we already gave up on once. Shorter, because by the time
// this runs the camera has had a full OPEN_TIMEOUT already.
const CLAIM_TIMEOUT = 8000

// How long a stream gets to produce its first frame once it is attached. A camera can open,
// hand over a live track, and send nothing — a 4K HDR sensor offering a format the browser
// cannot convert does exactly that, and it looks identical to a black room.
const FRAME_TIMEOUT = 5000

/**
 * What to ask for, in the order to ask.
 *
 * Asking for 4K is deliberate: `ideal` is a preference the browser satisfies as closely as it
 * can, and this used to ask for 1280x720 — which every camera worth having can do exactly, so
 * every camera did and a better sensor bought nothing.
 *
 * But `ideal` only promises not to *fail*. It says nothing about how long the driver will take
 * to negotiate, or whether what comes back is a format the browser can actually decode, and a
 * 4K HDR camera can lose on both counts while a 1080p request from the same camera opens
 * instantly. So it is a ladder, not a single ask, and a rung that opens but sends no picture is
 * a rung we climb down from.
 */
const LADDER = [
  { label: '4K', size: { width: { ideal: 3840 }, height: { ideal: 2160 } } },
  { label: '1080p', size: { width: { ideal: 1920 }, height: { ideal: 1080 } } },
  { label: 'whatever it offers', size: {} },
]

/**
 * The ladder, or the part of it `?res=` asks for.
 *
 *   ?res=1080   skip 4K entirely — for a camera that will not start at 4K, or starts and sends
 *               nothing, which is the one knob worth having on a kiosk shortcut
 *   ?res=any    ask for nothing in particular
 *   ?res=2560x1440   start there instead
 */
export function ladderFor(res) {
  const wanted = String(res ?? '').trim().toLowerCase()
  if (!wanted) return LADDER
  if (wanted === 'any' || wanted === 'auto') return LADDER.slice(-1)

  const exact = wanted.match(/^(\d{3,4})\s*[x\u00d7]\s*(\d{3,4})$/)
  if (exact) {
    const [, w, h] = exact
    return [
      { label: `${w}x${h}`, size: { width: { ideal: +w }, height: { ideal: +h } } },
      ...LADDER.slice(1),
    ]
  }

  const named = { '4k': 0, '2160': 0, '2160p': 0, uhd: 0, '1080': 1, '1080p': 1, hd: 1, fhd: 1 }
  return wanted in named ? LADDER.slice(named[wanted]) : LADDER
}

// A request we stopped waiting for. It is still open in the driver, and that is the whole
// reason this exists: asking for a second stream while the first is still being negotiated is
// how a slow camera becomes a dead one. Nothing here ever issues a request while this is set.
let slowRequest = null

/**
 * Take whatever a request we gave up on eventually produced.
 *
 * The version before this *stopped* the late stream — on the grounds that otherwise the camera
 * would be left running with nobody holding it. True, but it meant a camera that took eleven
 * seconds to open had its stream thrown away at eleven seconds, while a second request for the
 * same device was already in the air; the stop tore the device down underneath it. A camera
 * that is merely slow looked exactly like a camera that was broken, and the slower the sensor
 * the more reliably it happened.
 */
async function claimSlowRequest() {
  const req = slowRequest
  if (!req) return null
  slowRequest = null

  let timer
  const stillWaiting = Symbol('still waiting')
  const out = await Promise.race([
    req.catch(() => null),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(stillWaiting), CLAIM_TIMEOUT)
    }),
  ])
  clearTimeout(timer)

  if (out === stillWaiting) {
    // Put it back and let the page's own retry come round again. Not starting a second request
    // is the point: a driver this far behind will only be made worse by another one.
    slowRequest = req
    const err = new Error('the camera is still opening from the previous attempt')
    err.name = 'TimeoutError'
    throw err
  }
  if (out) setInfo('camera', 'the slow request answered after all - using that stream')
  return out
}

/**
 * getUserMedia, but it always answers, and only ever one at a time.
 *
 * On a wedged camera service the call does not reject — it simply never settles. That is worse
 * than an error, because an error can be caught and retried while a promise that never resolves
 * leaves start-up parked forever: no stream, no exception, no message on screen, and no retry,
 * because a retry that lives in a catch is never reached.
 */
function openStream(constraints, ms = OPEN_TIMEOUT) {
  const real = navigator.mediaDevices.getUserMedia(constraints)
  return Promise.race([
    real,
    new Promise((_, reject) =>
      setTimeout(() => {
        // Handed on rather than killed. Whoever asks next gets it.
        slowRequest = real
        const err = new Error(`the camera did not answer within ${ms / 1000}s`)
        err.name = 'TimeoutError'
        reject(err)
      }, ms)
    ),
  ])
}

/**
 * Wait for the stream to actually put a picture on the screen.
 *
 * `videoWidth` is the honest test. A track can be live, unmuted and enabled and still be
 * sending nothing — which is what a format the browser cannot convert looks like from here, and
 * it is indistinguishable from a working camera in a dark room until you notice the element has
 * no intrinsic size.
 */
function waitForFrames(video, ms = FRAME_TIMEOUT) {
  if (video.videoWidth) return Promise.resolve(true)
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      video.removeEventListener('loadedmetadata', seen)
      video.removeEventListener('resize', seen)
      resolve(Boolean(video.videoWidth))
    }
    const seen = () => video.videoWidth && finish()
    const timer = setTimeout(finish, ms)
    video.addEventListener('loadedmetadata', seen)
    video.addEventListener('resize', seen)
  })
}

export async function startCamera(video, { want = null, res = null } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    // Two very different faults land here and the fix for each is nothing like the other,
    // so say which one it is. An insecure origin is by far the more common: the camera API
    // is only exposed in a secure context, and `localhost` is the sole plain-http origin
    // that counts as one — open the LAN address over http and the API is simply absent.
    throw new CameraSetupError(
      window.isSecureContext
        ? 'This browser has no camera access. Use Chrome or Edge.'
        : `The camera needs a secure connection. This page is on ${location.origin} — open it over https:// or on http://localhost.`
    )
  }

  const rungs = ladderFor(res)
  setInfo('camera ladder', rungs.map((r) => r.label).join(' then '))

  // Resolved once we have a permissioned stream, because labels stay blank until then. Kept
  // across rungs so that climbing down does not also lose the camera `?cam=` asked for.
  let deviceId = null
  let picked = false
  let lastErr = null

  for (const rung of rungs) {
    // Anything still open from an earlier attempt is taken rather than fought with.
    let stream = await claimSlowRequest()

    if (!stream) {
      // `ideal`, not a bare value: as a hard constraint facingMode fails outright on hardware
      // with no front camera, and a preference costs nothing where there is one. Once a device
      // has been chosen by name or index it is named exactly instead — asking for a specific
      // device *and* the front camera contradicts itself the moment the chosen one is the rear.
      const aim = deviceId
        ? { ...rung.size, deviceId: { exact: deviceId } }
        : { ...rung.size, facingMode: { ideal: 'user' } }
      try {
        stream = await openStream({ video: aim, audio: false })
      } catch (err) {
        if (err.name === 'NotAllowedError' || err.name === 'SecurityError') throw err
        lastErr = err
        setInfo('camera ladder', `${rung.label}: ${err.name} - trying the next one down`)
        continue
      }
    }

    // Which camera, asked once, now that there is permission to read the labels.
    if (!picked && want !== null && want !== '') {
      picked = true
      stream = (await switchTo(want, stream, rung.size)) ?? stream
      deviceId = stream.getVideoTracks()[0]?.getSettings().deviceId ?? null
    }

    video.srcObject = stream

    // Not fatal if this rejects. Some Android builds reject play() spuriously while the element
    // is still being composited, and the `autoplay` attribute then starts it a moment later
    // anyway — so a rejection here is worth recording and carrying on with, not worth throwing
    // away a working stream over.
    try {
      await video.play()
      setInfo('play', null)
    } catch (err) {
      setInfo('play', `${err.name} - relying on autoplay`)
    }

    if (await waitForFrames(video)) {
      const got = stream.getVideoTracks()[0]?.getSettings()
      setInfo('camera ladder', `${rung.label} -> ${got?.width}x${got?.height}`)
      reportCameras(stream.getVideoTracks()[0])
      return {
        stream,
        stop() {
          stream.getTracks().forEach((t) => t.stop())
        },
      }
    }

    // Opened, and sent nothing. Let it go and ask for less: the same camera that cannot deliver
    // 4K here will very often hand over 1080p without complaint, because a smaller ask is a
    // different format and the format was the problem.
    setInfo('camera ladder', `${rung.label}: opened but sent no picture - asking for less`)
    lastErr = new Error(`the camera opened at ${rung.label} but sent no picture`)
    lastErr.name = 'NoFramesError'
    video.srcObject = null
    stream.getTracks().forEach((t) => t.stop())
  }

  throw lastErr ?? new CameraSetupError('No camera would open on this machine.')
}

/**
 * Swap to the camera `?cam=` asked for, if that is not the one already running.
 *
 * Returns the replacement, or nothing if the current stream is the right one or the swap
 * failed. The replacement is working *before* the old one is let go: stopping first and then
 * failing leaves no stream at all, and the failure happens before srcObject is ever assigned —
 * so the camera visibly turns on, goes dark, and the page reports no track.
 */
async function switchTo(want, stream, size) {
  setInfo('cam wanted', want)
  const deviceId = await pickDevice(want)
  const current = stream.getVideoTracks()[0]?.getSettings().deviceId

  if (!deviceId) {
    setInfo('cam wanted', `${want} - no match, kept the default camera`)
    return null
  }
  // `current` is routinely undefined on Android, where getSettings() reports less than it does
  // on desktop — so this cannot be `deviceId !== current`, which would be true even for the
  // camera already running and would re-request it for nothing.
  if (!current) {
    setInfo('cam wanted', `${want} - cannot confirm which is running, kept the default`)
    return null
  }
  if (deviceId === current) return null

  try {
    const next = await openStream({ video: { ...size, deviceId: { exact: deviceId } }, audio: false })
    stream.getTracks().forEach((t) => t.stop())
    setInfo('cam wanted', `${want} - switched`)
    return next
  } catch (err) {
    setInfo('cam wanted', `${want} - ${err.name}, kept the default camera`)
    return null
  }
}

async function pickDevice(want) {
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
  if (!inputs.length) return null

  if (/^\d+$/.test(String(want))) {
    return inputs[Number(want)]?.deviceId ?? null
  }
  const needle = String(want).toLowerCase()
  return inputs.find((d) => d.label.toLowerCase().includes(needle))?.deviceId ?? null
}

export class CameraSetupError extends Error {
  name = 'CameraSetupError'
}
