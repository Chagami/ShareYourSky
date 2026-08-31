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

export async function startCamera(video, { want = null, width = 1280, height = 720 } = {}) {
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

  // `ideal`, not a bare value: as a hard constraint this fails outright on hardware with no
  // front camera, and a preference costs nothing where there is one.
  const size = { width: { ideal: width }, height: { ideal: height } }
  const base = { ...size, facingMode: { ideal: 'user' } }

  // One permissioned stream first: device labels stay blank until access is granted.
  //
  // With a fallback, because constraints are the single most common reason a camera that is
  // sitting right there refuses to open. Every value above is only a *preference*, which in
  // theory can never over-constrain — in practice browsers differ on whether they will honour
  // a combination of them, and Firefox is stricter than Chrome. A camera at whatever size it
  // feels like giving us beats no camera at all, so if the preferred request is refused, ask
  // for nothing in particular and take what arrives.
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: base, audio: false })
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') throw err
    setInfo('fallback', `${err.name} on preferred constraints - retried with plain video`)
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
  }

  if (want !== null && want !== '') {
    setInfo('cam wanted', want)
    const deviceId = await pickDevice(want)
    const current = stream.getVideoTracks()[0]?.getSettings().deviceId

    // `current` is routinely undefined on Android, where getSettings() reports less than it
    // does on desktop — so this cannot be `deviceId !== current`, which would be true even for
    // the camera already running and would re-request it for nothing.
    if (deviceId && current && deviceId !== current) {
      try {
        // Get the replacement working *before* letting go of what we have. Stopping first and
        // then failing leaves no stream at all, and the failure happens before srcObject is
        // ever assigned — so the camera visibly turns on, goes dark, and the page reports no
        // track. No facingMode here either: on a phone every camera has one, so asking for a
        // specific deviceId *and* the front camera contradicts itself the moment the chosen
        // device is the rear one.
        const next = await navigator.mediaDevices.getUserMedia({
          video: { ...size, deviceId: { exact: deviceId } },
          audio: false,
        })
        stream.getTracks().forEach((t) => t.stop())
        stream = next
        setInfo('cam wanted', `${want} - switched`)
      } catch (err) {
        setInfo('cam wanted', `${want} - ${err.name}, kept the default camera`)
      }
    } else if (deviceId && !current) {
      setInfo('cam wanted', `${want} - cannot confirm which is running, kept the default`)
    } else if (!deviceId) {
      setInfo('cam wanted', `${want} - no match, kept the default camera`)
    }
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

  reportCameras(stream.getVideoTracks()[0])
  return {
    stream,
    stop() {
      stream.getTracks().forEach((t) => t.stop())
    },
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
