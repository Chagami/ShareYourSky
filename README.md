# Is It Real?

A single-visitor exhibit interaction about where the color in an astronomical image comes
from. The visitor is shown in black and white before they touch anything, takes one exposure,
is asked where the color went — and then turns one dial that recolors both their own portrait
and a real telescope frame through a set of colormaps. The brightness never changes. Only the
color encoding does.

The interaction is the physics: acquisition produces an intensity map, processing chooses how
to show it.

Deliberately chrome-free. No nav bar, no menus, no settings. Everything on screen is either
part of the interaction or a description of it.

## Run

```bash
cd IsItReal
npm install
npm run dev
```

- Interaction screen → `http://localhost:5173/`
- Gallery wall → `http://localhost:5173/gallery.html`

Open the two in separate windows and drag each to its display. Chrome or Edge, full screen
(F11). `localhost` counts as a secure context, so the camera works without HTTPS — serving
the interaction screen to another device over the LAN would need a certificate.

Vanilla JS, no framework: Vite is here for the dev server, HMR and a bundled build, not for
a component model. `vite.config.js` lists both HTML files as build inputs.

### For the exhibit

```bash
npm run build     # -> dist/
npm run preview   # serve dist/ to check it before deploying
```

`base` is `'./'`, so `dist/` runs from any folder — a subdirectory, a USB stick, any static
host — without rewriting paths. Verified: the full flow passes identically against `dev` and
against the built output.

### Picking the camera

The exhibit PC has more than one video input, and a dropdown has no place on a visitor
screen, so the choice lives in the URL of the kiosk shortcut:

```
http://localhost:5173/?cam=1          second video input, by order
http://localhost:5173/?cam=Logitech   first input whose label contains "Logitech"
```

With no parameter it uses the browser's default.

## The flow

| Stage | What the visitor sees |
| --- | --- |
| `approach` | Live feed, **already grayscale**. "This is what the camera actually measures — how much light, not what color." |
| `hinge` | One exposure freezes in place at the same size. **"Where's the color?"** Held for 3.4s before anything else is offered — this is the fulcrum, don't shorten it. |
| `map` | The first turn of the dial opens this beat. Their portrait and a real telescope frame sit side by side and recolor together as one knob sweeps the colormaps. |
| `sendoff` | Both panes stay on screen as evidence while the label resolves it. Restart at 5s, automatic restart at 30s. |

### Two inputs, matching the plinth

The whole piece runs on **one button and one rotary control**, and nothing else:

| Input | `approach` | `hinge` | `map` |
| --- | --- | --- | --- |
| Button | take the exposure | — | keep it |
| Dial | — | first turn advances | choose the colormap |

On screen the shutter and the slider fire the same two actions, and Space/Enter plus the
arrow keys drive them for testing. Real hardware is opt-in with `?plinth` — see below.

## Color science

`js/imaging.js` and `js/colormaps.js` are the whole of it, and the split between them is the
argument.

`captureIntensity()` reduces the frame to **one brightness value per pixel** (Rec. 709 luma —
the same coefficients CSS `filter: grayscale()` uses, so the live preview and the frozen
exposure are the same image and the freeze is seamless). That array is written once and then
only ever read.

`drawMapped()` is the only thing the dial does: a 256-entry lookup table over that untouched
array. The measurement is provably fixed — verified by sweeping every palette and confirming
the recovered intensity is bit-identical to the original (drift 0).

Grayscale is deliberately **first** on the dial. It is the un-chosen option, the raw
measurement, so every turn away from it is visibly an authored decision. To add or retune a
palette, edit the `PALETTES` anchors in `js/colormaps.js` — they are plain hex control points,
interpolated linearly, no colour-science dependency to fight.

## Where to change things

- `index.html` — **every word the visitor reads.**
- `js/colormaps.js` — the palettes, as editable hex anchors.
- `js/main.js` — the `TIMELINE` object at the top is the entire pacing of the piece in one
  block, including `hingeHold` (how long the fulcrum is held) and the restart timings.
- `css/app.css` — `--frame-h` and `--pane-h` are the two image sizes; the beat-switching
  rules at the bottom (`body[data-stage="..."]`) decide what is on screen when.
- `js/nebula.js` — the telescope panel, and how to drop in real data.
- `js/store.js` — the gallery store (`MAX_ITEMS`, quota handling).
- `vite.config.js` — dev port, LAN host, the two build inputs.

### Animation approach

Entrances are driven from `main.js` with the Web Animations API rather than CSS classes.
The flow is one long timed sequence, and a restart has to be able to abort it from any
point: `cancelAll()` bumps a generation counter, which cancels every in-flight animation and
leaves any pending `wait()` unresolved forever. Nothing from an abandoned turn can bleed
into the next visitor's. CSS keeps only the always-on decoration (shutter halo, flash) and
the rules that hold elements hidden until an animation claims them.

## The telescope panel — before this ships

`js/nebula.js` currently renders a **synthetic placeholder** and captions it
"Simulated frame — placeholder". It must not go in front of visitors claiming to be real data,
and the transfer beat only lands if the sky panel genuinely is a telescope measurement.

To fix, before the exhibit opens:

1. Drop a monochrome single-filter frame at `public/nebula.png` — one filter's exposure, e.g.
   an Hα frame from hubblesite.org, or an SDSS/DSS plate. It is picked up automatically.
2. Set `REAL_LABEL` in `js/nebula.js` to name the object, instrument and filter
   (e.g. `'M16 · Hubble/WFC3 · Ha'`). A real exhibit must caption real data.

The placeholder is seeded, so it looks identical every session rather than changing each
morning.

## Hardware

`?plinth` asks for the USB serial device on load (Chrome/Edge). One line per reading at
115200 baud:

```
pot\n          rotary position, 0..1023
pot,btn\n      plus the button, 0/1 — a rising edge fires the button action
```

Same shape as the FiltersNew firmware, minus two pots. **Untested against real hardware** —
the on-screen dial and shutter drive the same two actions, so the piece runs fully without it.

## Still open

- **The QR takeaway.** The send-off currently sends the image to the gallery wall with its
  palette name. An ephemeral-QR handoff needs a URL a phone can reach, which means a real
  server — `localStorage` cannot do it. That is an architecture decision, not a small addition:
  see the upgrade path below.

## Exhibit-grade upgrade path

The wall is fed through `localStorage` plus `BroadcastChannel`, which means one machine, one
browser, and a 24-image cap (`js/store.js` drops the oldest entries rather than losing the
image a visitor just made when quota is hit). To run the wall on a different device, keep
images permanently, **or hand a visitor a QR code**, replace `list()` and `publish()` with
calls to a small server — the rest of the app never touches storage directly.

## Lineage

Fourth prototype in `AstroProto/`. The intensity-plus-lookup-table pipeline comes from
`FiltersGreyscale/web/index.html`, the multi-display + `BroadcastChannel` arrangement and the
serial protocol from `FiltersNew/`, and the mirrored-capture and camera-selection lessons from
`Filters/`.
