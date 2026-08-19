// Optional hardware: the plinth's one rotary control and one button, over USB serial.
//
// The exhibit is designed around exactly two physical inputs, so the wire protocol is one
// line per reading at 115200 baud:
//
//   pot\n            rotary position, 0..1023
//   pot,btn\n        plus the button, 0 or 1  (a rising edge fires the button action)
//
// Same shape as the firmware from FiltersNew, minus two pots. Chrome/Edge only, and the page
// must be a secure context — localhost counts.
//
// NOTE: unverified against real hardware. The on-screen dial and shutter drive the same two
// actions, so the piece runs fully without a Teensy attached.

export function serialSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator
}

export async function connectPlinth({ onDial, onButtonPress }) {
  if (!serialSupported()) throw new Error('Web Serial needs Chrome or Edge.')

  const port = await navigator.serial.requestPort()
  await port.open({ baudRate: 115200 })

  const decoder = new TextDecoderStream()
  port.readable.pipeTo(decoder.writable).catch(() => {})
  const reader = decoder.readable.getReader()

  let buf = ''
  let lastBtn = 0
  let stopped = false

  ;(async () => {
    try {
      while (!stopped) {
        const { value, done } = await reader.read()
        if (done) break
        buf += value
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          const parts = line.trim().split(',').map(Number)
          if (!parts.length || Number.isNaN(parts[0])) continue

          onDial?.(Math.max(0, Math.min(1023, parts[0])))

          if (parts.length > 1) {
            const btn = parts[1] ? 1 : 0
            if (btn && !lastBtn) onButtonPress?.()
            lastBtn = btn
          }
        }
      }
    } catch {
      /* reader cancelled */
    }
  })()

  return {
    async close() {
      stopped = true
      try {
        await reader.cancel()
        reader.releaseLock()
      } catch {}
      try {
        await port.close()
      } catch {}
    },
  }
}
