# Share Your Sky

> Forked from [Chagami/IsItReal](https://github.com/Chagami/IsItReal) at `27729d8`, carrying that
> repo's history. The two have since diverged: `IsItReal` is the one-dial colormap piece, this is
> the guided per-channel levels piece.

A single-visitor exhibit interaction about how an astronomical image gets made. The visitor takes
a photo on a countdown, then is walked through what the camera actually did with the light: it
was filtered into red, green and blue, and each of those can be stretched or crushed
independently. They set the black and white point for each channel, watch their version emerge
out of the camera's original, and share it to a gallery wall.

Deliberately chrome-free. No nav bar, no menus, no settings. Everything on screen is either part
of the interaction or a description of it.

## Run

```bash
cd IsItReal-experiment
npm install
npm run dev
```

- Interaction screen → `https://localhost:5173/`
- Gallery wall → `https://localhost:5173/gallery.html`

Chrome or Edge, full screen (F11). Vanilla JS, no framework — Vite is here for the dev server,
HMR and a bundled build, not for a component model.

### Why HTTPS

The camera API is only exposed in a **secure context**. `localhost` is the one plain-http origin
that qualifies; open the LAN address over `http://` and `navigator.mediaDevices` is not merely
blocked, it is undefined. So the dev and preview servers both run TLS
(`@vitejs/plugin-basic-ssl`), which makes *every* address a secure context and lets the
interaction screen run on a second machine:

```
https://<this-machine's-IP>:5173/
```

The cert is self-signed and generated on first run into `node_modules/.vite/basic-ssl/`, so each
new client gets one **"Your connection is not private"** interstitial — *Advanced → Proceed*.
After that the camera works normally. Two things follow from it:

- To lose the warning entirely, issue a cert with [mkcert](https://github.com/FiloSottile/mkcert)
  (`mkcert -install && mkcert <IP> localhost`), point `server.https` at the pair instead of the
  plugin, and install the mkcert root CA on each client.
- Camera permission is granted **per origin**. Moving from `localhost` to the HTTPS LAN address
  is a new origin, so the browser prompts again — and `?cam=` matching by label only works after
  that prompt is answered, since device labels stay blank until it is.

If the camera fails, the on-screen message distinguishes the two causes: an insecure origin names
the origin it is on, an unsupported browser says so.

> **Watch the port.** If another Vite server is already running, Vite silently takes the next
> free one and prints it. Read the terminal output rather than assuming 5173.

### For the exhibit

```bash
npm run build     # -> dist/
npm run preview   # serve dist/ over https on :4173 to check it before deploying
```

`base` is `'./'`, so `dist/` runs from any folder without rewriting paths.

`dist/` is **committed**, so a clone runs on an exhibit PC with no Node install — but that means
it can go stale. Rebuild and commit it in the same commit as any change to `js/`, `css/` or the
HTML, or the deployed copy will quietly lag the source.

### Picking the camera

The exhibit PC has more than one video input, and a dropdown has no place on a visitor screen, so
the choice lives in the URL of the kiosk shortcut:

```
?cam=1          second video input, by order
?cam=Logitech   first input whose label contains "Logitech"
?cam=back       Android labels read "camera2 1, facing back", so this matches
```

**On a tablet, Android's permission prompt has no camera picker.** Desktop Chrome lets you
choose a device in the permission bubble; Android gives you Allow or Block and the page decides.
So `?cam=` is the only way to choose there. To find out what to put in it, open the debug overlay
(hold the top-left corner for 1.5s) — it lists every input with the index to use, marks the one
in use, and shows the secure-context and permission state above it.

Two things that only bite on a phone or tablet:

- Asking for a specific `deviceId` **and** a `facingMode` contradicts itself as soon as the
  chosen device is the rear camera, and fails with `OverconstrainedError`. The device-specific
  request therefore sends no `facingMode` at all. Desktop never shows this up, because desktop
  cameras report no facing.
- `facingMode` is requested as `ideal`, not as a bare value. As a hard constraint it fails
  outright on hardware with no front camera.

### When the camera will not open

`openCamera()` retries every `cameraRetryAt` (15s) until it succeeds, then clears the error and
re-arms the shutter. A camera can be unavailable for reasons that have nothing to do with this
page and that clear up on their own — another app holding it, or the device's own camera service
wedged until something releases it. Without the retry, a fault at 9am is a dead exhibit until
somebody notices, even if the camera freed itself a minute later. It deliberately sits outside
the generation counter `reset()` bumps: recovery has to outlive a visitor's turn.

Under the visitor-facing message is a **small service note** giving the fault name, the origin,
the secure-context state, the browser engine and the retry count. Whoever is standing in front
of a kiosk that will not start has no debugger and usually no second machine, so a photograph of
the screen has to be enough to work from.

> **Suspect the device before the code.** A wedged camera service reports `NotReadableError` and
> is cleared by restarting the device. From the browser's side it looks exactly like a
> permissions or constraints bug, and it is neither — this cost a long debugging session once
> already. Read the service note before changing anything.

## The four steps

Portrait, 2160&times;3840, built to read like a very large phone: the content fills the upper
part and the one thing to press is always at the foot, within reach.

| Step | Screen | The dock offers |
| --- | --- | --- |
| `camera` | Title, viewfinder, countdown | the shutter |
| `edit` | Their photo, and three levels charts under it | `Next` |
| `share` | The picture they made | `Share my sky` |
| `astro` | The same photo through each colour on its own, with a chart each, and all three recombined below | `Start again` |

Each step is a self-contained `<section>`; only one is on screen, chosen by `body[data-step]`.
`STEP_ENTER[id]` is the only place a step's content is built, and **no step knows about any
other** — a step builds what it needs from `frame` and `levels` and does not care how the
visitor arrived.

That is what makes them separable, and it buys the thing worth having while building:

```
?step=edit     open one step directly, without sitting through the ones before it
```

It takes a photo as soon as the camera is ready and then jumps, so the step has something real
to work with.

### The dock

Always on screen: the one action this step offers, and where the visitor is in the sequence.
Which button shows is derived from `STEPS[i].action`, so there is exactly one place to look when
a step offers the wrong control. The indicator marks the current step and everything passed,
with the rule between marks drawn behind them so progress reads as a line being walked.

### A camera mounted sideways

`?rot=90`, `?rot=180`, `?rot=270`. A URL parameter for the same reason `?cam=` is: which way the
camera sits is a property of the bracket it is screwed to, not of the exhibit.

Two things that are easy to get wrong here, both of which did:

- **The capture has to be turned too.** `drawImage` reads the raw frame, not what a CSS
  transform made of it, so without the matching rotation in `captureFrame()` the photo comes out
  at ninety degrees to the viewfinder the visitor was looking at.
- **`setAspect()` takes the camera's dimensions, never the frame's.** `captureFrame` has already
  applied the rotation to the frame; passing it back in makes the swap happen twice and inverts
  the aspect ratio for every screen after the first.

On a quarter turn the video element is given the frame's dimensions **swapped** before being
turned, so that once rotated it lands exactly on the frame. Scaling a correctly-sized box up
afterwards is the obvious move and the wrong one: it leaves the picture letterboxed inside its
own frame, because a 3:4 box turned sideways is 4:3 and no longer fits what it came from.

## The levels editor

`js/levels.js`. A histogram with the black-point and white-point handles built into its baseline,
rather than a chart with a slider bolted underneath.

- **The handles open on the channel's own range, and slide there.** Resting at 0 and 255 put
  them half off each end of the chart, where they read as end-caps of the frame rather than as
  objects on a track — and a first drag of the white point could travel a long way before it
  touched a single pixel, which reads as a broken control. `restingLevels()` takes the 0.5th and
  99.5th percentile of that channel's histogram, clamped to stay at least `MIN_INSET` (16 levels) off each
  end, and `settleLevels()` tweens the handles out to it once the editor has landed. The
  movement is the affordance: this is a touchscreen, so there is no hover state to hint with.
- **Log-scaled bins.** A photo's histogram is dominated by a few huge bins; a linear plot
  flattens everything else into an unreadable line along the axis.
- **The clipped shoulders are dimmed** and the levels ramp is drawn over the top, so the visitor
  can see what they are throwing away.
- **Custom handles, not range inputs.** Two overlaid full-width ranges fight for the same pointer
  when the values get close. These are focusable `role="slider"` widgets with arrow-key support
  (shift for ×10), so they stay keyboard- and test-drivable.
- **`touch-action: none`, or the drag keeps stopping.** Without it the browser runs gesture
  detection on every touch, decides a horizontal drag might be a pan, and fires `pointercancel`
  — which silently ends the drag mid-gesture. It looks exactly like a flaky touchscreen and is
  nothing of the kind; it happens on a fast phone too.
- **The whole plot is the drag surface, not just the handles.** Pressing anywhere on the chart
  grabs the nearer handle and keeps it until the finger lifts, and the pointer is captured on
  the plot rather than on the handle — a drag that starts a few pixels off a handle used to be
  captured by nothing and go nowhere. Press *on* a handle and it grabs where it is; press
  anywhere else and it jumps to the touch.
- **Touch targets, not just chips.** The visible handle is 26px; a transparent `::before`
  inflates the hit area to 52×48, past the 44px minimum. The card carries **26px of bottom
  padding in px, not vh**, because that overhang is a fixed size and has to be reserved — a
  target that spills out of the card lands on whatever sits underneath it.
- **They pulse until they are touched.** A channel-coloured ring expands out of each handle once
  it has settled, and stops for good on the first movement (`setPulsing()` / the `touched` flag
  in `createLevels`). This is a touchscreen: there is no hover state to hint with, and nothing
  else on screen says these two chips are the thing to grab. A cue that keeps running after it
  has been understood stops being a cue and becomes noise.
- **The pulse is a ping, not a swell.** The ring expands at a steady rate over the first 45% of
  the cycle and then holds invisible for the rest. Easing across the whole 2.3s instead put
  nearly all the travel in the first half-second and left the ring crawling for the remainder —
  which reads as dropped frames even at a solid 75fps. It is a *feathered* ring (a radial
  gradient), not a 2px border: a crisp border being scaled either re-rasterises every frame or
  blurs as the layer stretches, while a soft edge has nothing to spoil.
- **Next is earned.** It stays hidden and non-interactive until a handle has actually moved, so
  the visitor cannot skip past the one interaction the piece is about. `revealNext()` is called
  from the first-touch callback — **and from an 18s fallback timer** (`nextFallbackAt`), because
  gating the only way forward on a gesture somebody has to discover is how you strand a visitor
  at an unattended exhibit. Moving **either** handle opens the gate; requiring both would triple
  the chance of getting stuck for no extra teaching.
- **The backing store is sized to the on-screen size × DPR** on every draw. The chart is laid out
  `width: 100%` with a fixed `aspect-ratio`, so it is routinely displayed far wider than its
  authored size and would otherwise be a blurry upscale.

The large walkthrough editors and the three compact ones are **separate instances over shared
state** (`get`/`set` closures into one `levels` array), so they can never disagree.

## Image pipeline

`js/imaging.js`. The capture is split into its real R, G and B planes once, plus a luma plane.
Everything after that is a per-channel levels curve applied as a 256-entry lookup table:

```
out = clamp((in - black) / (white - black)) * 255
```

The planes are written once and only ever read, so the underlying measurement survives no matter
how far the levels are pushed — `reveal` can always go back to the camera's original because it
is still there.

## Where to change things

- `index.html` — **every word the visitor reads.**
- `js/main.js` — the `TIMELINE` object at the top is the entire pacing of the piece in one block:
  countdown cadence, the didactic beats, the three reveal crossfades, the reset timings.
- `css/app.css` — `--live-h` and `--bay-h` are the two photo sizes; the beat-switching rules at
  the bottom (`body[data-stage="..."]`) decide what is on screen when.
- `js/levels.js` — the editor and the histogram drawing.
- `js/store.js` — the gallery store (`MAX_ITEMS`, quota handling).
- `js/perf.js` — the in-situ performance readout. See above for how to summon it.

### Animation approach

Entrances run from `main.js` with the Web Animations API rather than CSS classes. The flow is one
long timed sequence and a reset has to abort it from any point: `cancelAll()` bumps a generation
counter, cancelling every in-flight animation and leaving any pending `wait()` unresolved forever.
Nothing from an abandoned turn can bleed into the next visitor's.

Two guards to keep in mind if you add elements:

- `revealAll()` skips anything marked `[data-hold]`. The reset button carries `.rise` but is
  revealed on its own 3-second timer; without the guard it fires early *and* ends up with two
  competing animations on the same element.
- `.btn.rise:disabled { opacity: 0 }` has to outrank `.btn:disabled { opacity: .35 }`, or a
  not-yet-revealed button sits on screen greyed out. It also needs `pointer-events: none`:
  `opacity: 0` gives the button a stacking context, so an invisible Next paints *over* the
  levels handles beneath it and silently swallows taps meant for them.

### Performance, and how to read it in situ

The exhibit machine is not the machine this was written on, so the meter travels with the build.
`js/perf.js` shows rolling frame time, the count of frames over 25&nbsp;ms, the cost of a full
levels redraw, and the current stage. Three ways in:

| | |
| --- | --- |
| `?perf=1` | on from the URL, for a bench session |
| `?fx=lite` | no blur, no blend modes, no idle animations |
| `?fx=off` | as above, and the light shafts removed entirely |
| press <kbd>P</kbd> | on a machine with a keyboard |
| hold the top-left corner for 1.5s | for a touchscreen on the floor |

It never persists across a reload, so one left on by accident cannot outlive the session; it is
`pointer-events: none`, so it can never eat a visitor's touch; and the sampling loop only runs
while it is showing, so it costs nothing when off.

Alongside the timings it reports the **build stamp**, the secure-context and camera-permission
state, the camera list with the `?cam=` index for each, and running **node / canvas / heap**
counts. Those last three are how you spot a leak on a machine you cannot attach a debugger to —
they should be flat across visitors, and a kiosk never restarts, so anything that grows has all
day to do it.

The `?fx` modes are applied by a small inline script **before the module loads**, because on
hardware where the heavy effects are the problem, one painted frame of them is one too many.
They are also the fastest way to find out whether the GPU is what is wrong: if `?fx=lite` stops
a crash or a stutter, it is; if it does not, look elsewhere.

> **A stale kiosk looks identical to a fresh one.** Asset filenames are content-hashed so they
> bust themselves, but `index.html` is not — a device that has cached it keeps loading the old
> assets it names, indefinitely. The build stamp in the overlay is the only way to tell from the
> floor. Serve `index.html` with `Cache-Control: no-cache` on the exhibit machine.

**What a drag used to cost, and why.** Roughly half the work on the hot path was bookkeeping
rather than imaging:

- `pointermove` ran a full redraw **synchronously**, so a touchscreen firing faster than the
  display redrew more often than anything could be seen.
- All **six** editors refreshed on every move — including the three touch-ups that are
  `display: none` during tuning, and the two channels that had not changed.
- `drawHistogram` read `clientWidth` on every draw, forcing a synchronous layout six times per
  move. On a hidden editor that reads 0, so the canvas was reallocated to 1px and drawn into,
  every move, for nothing.

Now: redraws are marked dirty and coalesced to **one a frame**, only the channel that moved is
redrawn, only editors that are on screen are touched, and the backing store is sized from a
`ResizeObserver` off the layout pass rather than by asking for layout on the hot path. Working
copies dropped to 420px (preview) and 200px (thumbnails).

Measured on a sustained 150-move drag: a full redraw went **4.9&nbsp;ms &rarr; 0.80&nbsp;ms**,
with zero frames over 25&nbsp;ms. The remaining cost is the per-pixel JS, which is the next thing
to move to a WebGL shader if a weaker machine needs it.

## Exhibit-grade upgrade path

The wall is fed through `localStorage` plus `BroadcastChannel`: one machine, one browser, a
24-image cap (`js/store.js` drops the oldest rather than losing the image a visitor just made). To
run the wall on a different device, keep images permanently, or hand a visitor a QR code, replace
`list()` and `publish()` with calls to a small server — nothing else touches storage.

## Lineage

Fifth prototype in `AstroProto/`, forked from `IsItReal`. The levels/histogram reasoning goes back
to `FiltersGreyscale/web/index.html` (black point, contrast and brightness as a shared tone LUT),
the multi-display + `BroadcastChannel` arrangement to `FiltersNew/`, and the mirrored-capture and
camera-selection lessons to `Filters/`.
