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
```

## The flow

| Stage | What the visitor sees |
| --- | --- |
| `live` | **Share Your Sky**, live feed, viewfinder corners, one shutter button. |
| `countdown` | 5 · 4 · 3 · 2 · 1, each number scaling through, then a flash. |
| `intro` | The photo lifts off the viewfinder, drifts right as it swells, then travels left and shrinks into the bay. "When you took a photo, the camera captured" types itself out; **light** lands on its own row at twice the size, with god rays falling onto it. |
| `tuneR` / `tuneG` / `tuneB` | "That light was filtered into **R G B**", one chip lit at a time. The god rays split into a dull rainbow and light the band belonging to the current channel. A levels editor for that channel, and the photo shows **that channel alone**. `Next` advances. |
| `reveal` | Brightness only → as the camera captured it → your version. Three crossfades, the last one slow. |
| `finale` | Three compact editors for final touches, plus the essay. `Share my sky`. |
| `thanks` | The photo is blown off to a random edge, spinning. "Thanks for sharing your sky." Reset button after 3s. |

Two decisions worth knowing, because they aren't obvious from the spec:

- **While tuning one channel, the photo shows that channel alone**, tinted. Showing the full
  composite there would spoil the `reveal` beat, which is the first time the visitor sees their
  three choices combined.
- **The photo never moves between `intro` and `finale`.** One anchored bay, one swapping
  right-hand panel. Moving an image while someone is dragging a handle beside it reads as a bug.

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

### Beats leave, they are not switched off

`dismiss()`. Both sentences used to be removed by a CSS rule firing on the stage change —
`visibility: hidden` for the first one at `reveal`, `display: none` for both at `finale`. That
cut them dead in one frame, and the second sentence sat there through the whole 4.8s reveal
before it happened. Now they fade and drift out, and the second one is dismissed **partway
through the last crossfade** rather than on the way into the finale, so the panel is already
empty when the essay arrives and the exit costs no extra time.

Both fades are `linear`, and that is deliberate. An eased fade holds near full opacity for most
of its duration and then dumps the rest in a few frames: measured, `cubic-bezier(.55,0,.9,.35)`
stepped opacity by **0.13 in a single frame** where linear steps by **0.026**. That late dump is
itself the hang-then-cut the dismissal was added to fix. The same trap caught the handle pulse —
if a transition ever looks like dropped frames, check the curve before blaming the frame rate.

### The hand-off into the bay

`morphPhotoIntoBay()`. A FLIP: the photo stack is already sitting in its final place, so it
measures both boxes, starts the stack transformed onto the live viewfinder, and animates back to
no transform. The midpoint is the point — a drift right and a slight swell (`photoSwell`) before
the long travel left (`photoSettle`). A straight tween from big-and-centred to small-and-left
reads as the image collapsing.

Two things fall out of it. `takePhoto()` calls `feed.pause()`, because a live frame still moving
underneath the photo during its flight reads as a double exposure — `reset()` plays it again. And
`.stage:not(.active)` exits in 220ms rather than 460ms, so the outgoing live section is gone
before the photo has displaced far enough to expose it.

### Typing, and "light"

The first beat types itself out. Every character is in the DOM from the start and merely hidden
(`splitChars()` wraps each word in an inline-block and each character in a span): **appending**
characters would re-wrap the line on nearly every keystroke and shove the panel around, whereas
revealing them settles the line breaks once, before anything is visible. The caret is an
`::after` on whichever character was typed last, so it follows the text across a line break for
free, and it is absolutely positioned so it never nudges the glyphs.

"light" is *not* typed — five characters at that size read as a banner, and the shafts need
something to land on all at once. It blooms in as one word.

### The god rays

`.rays` is seven trapezoid shafts hinged at a point above the word and splayed outward, so they
read as one beam breaking apart rather than seven stripes. Hue and angle come from `nth-child`
in the CSS; the shafts start desaturated (`saturate(0)`) so the beam is white.

- `.rainbow`, added when the second sentence lands, takes the desaturation only part way off.
  The rainbow has to stay **dull**, or the one band the visitor is working on has nothing to
  stand out against.
- `data-band="r|g|b"`, set by `enterTune()`, brightens that channel's shafts. Red covers
  red+orange, green covers yellow+green, blue covers cyan+blue+violet — the sensor's filters
  overlap in roughly the same way.
- No `mix-blend-mode` on `.rays`. A blended element cannot be composited on its own layer —
  the browser re-reads the backdrop every frame — and these shafts are blurred *and* animating,
  which made them the one genuinely expensive thing on the screen. Over a near-black page
  `screen` renders pixel for pixel the same as normal compositing, so it was pure cost.
- The idle drift animates **transform only**. An unregistered custom property does not
  interpolate in `@keyframes` (it snaps at 50%), and an animated `opacity` would outrank the
  state rules, so the dull/lit switch would never show.

### Text that glides instead of teleporting

`flipPanelText(mutate)`. The workbench is vertically centred, so anything that changes the
panel's height — the levels editor arriving, the Next button appearing — shunts every line above
it by half that height in a single frame. It measures the panel's children, runs the stage
change, and animates the difference away over `panelShift`. Wrap any future stage change that
adds or removes panel content in it.

### The animated words

`.w-ir` (infrared) glows on a slow cycle, sitting just outside the visible range. `.w-wave`
(wavelengths) is split into per-letter spans, each running the same `wave` keyframe with a
staggered `animation-delay`, so the wiggle travels through the word as a sine wave. Most of the
5.5s cycle is flat, so it kicks in occasionally rather than jittering constantly.

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
