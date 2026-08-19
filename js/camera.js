// Camera start-up with no on-screen picker.
//
// The earlier prototypes needed a camera selector because the exhibit PC has more than
// one video input (Filters/ hardcoded CAMERA_INDEX = 1). Rather than put a dropdown on a
// visitor-facing screen, the choice is a URL parameter on the kiosk shortcut:
//
//   index.html?cam=1          -> second video input, by order
//   index.html?cam=Logitech   -> first input whose label contains "Logitech"
//
// With no parameter it takes whatever the browser hands over by default.

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

  const base = { width: { ideal: width }, height: { ideal: height }, facingMode: 'user' }

  // One permissioned stream first: device labels stay blank until access is granted.
  let stream = await navigator.mediaDevices.getUserMedia({ video: base, audio: false })

  if (want !== null && want !== '') {
    const deviceId = await pickDevice(want)
    const current = stream.getVideoTracks()[0]?.getSettings().deviceId
    if (deviceId && deviceId !== current) {
      stream.getTracks().forEach((t) => t.stop())
      stream = await navigator.mediaDevices.getUserMedia({
        video: { ...base, deviceId: { exact: deviceId } },
        audio: false,
      })
    }
  }

  video.srcObject = stream
  await video.play()
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
