# Is It Real?

A single-visitor exhibit interaction about where the color in an astronomical image comes
from. The visitor photographs themselves, is asked whether the photo looks real, then takes
it apart: the photo is reduced to brightness only, that one greyscale frame is assigned to
red, green and blue, and they mix the three by hand. The result goes up on a gallery wall
and the question comes back — *is this photo real?*

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
| `live` | Full mirrored feed with a shutter button inside the frame. |
| `ask` | The photo slides aside; **Is It Real?** pops in, then five smaller questions, then a button. |
| `process` | Everything wipes; the photo flies to the top and desaturates; its three measured color channels are pulled out of it; sliders and a live composite rise up. |
| `final` | The edited image returns to the centre under **Is this photo real?** Restart button at 5s, automatic restart at 30s. |

Publishing writes to the wall and moves the interaction to `final` — the wall is a separate
display and the interaction screen never navigates away from itself.

## Color science

`js/imaging.js` is the whole of it.

`channelLayers()` splits the capture into its three **measured** planes — the actual red,
green and blue values in the visitor's photo. Each card renders one plane in its own color,
scaled by its slider; `drawComposite()` writes each plane back into its own output channel.
These are separations, not three tinted copies of the photo's brightness: each card is
bright only where its own filter actually caught light, so they hold visibly different
images.

The consequence is the point of the exhibit: with all three sliders at 100% the composite
reconstructs the captured photo **exactly, pixel for pixel** (verified — reconstruction
error 0). Neutral is the truth. Every other setting is visibly a choice the visitor made,
which is the same choice made for every image of space they have ever seen.

The composite is written as a 3×3 mix rather than a straight copy, so replacing the three
`CHANNELS` colors with a different palette still recombines correctly. Rewrite
`drawComposite()` to change the science.

The greyscale step before the split is presentational — a CSS `filter: grayscale()` on the
photo, no pixel data involved. It sets up the reveal: a sensor only measures brightness, and
it does that three times, behind three filters.

## Where to change things

- `js/main.js` — the stage machine and all choreography timings. `PACE`, `RESTART_BUTTON_AT`,
  `AUTO_RESTART_AT` at the top.
- `js/imaging.js` — the color science, `WORK_W`/`FULL_W` resolutions.
- `index.html` — every word the visitor reads, including the five follow-up questions.
- `css/app.css` — the `.shot.at-*` classes are the photo's resting places in each stage;
  that one element travels through the entire flow.
- `js/store.js` — the gallery store (`MAX_ITEMS`, quota handling).
- `vite.config.js` — dev port, LAN host, the two build inputs.

### Animation approach

Entrances are driven from `main.js` with the Web Animations API rather than CSS classes.
The flow is one long timed sequence, and a restart has to be able to abort it from any
point: `cancelAll()` bumps a generation counter, which cancels every in-flight animation and
leaves any pending `wait()` unresolved forever. Nothing from an abandoned turn can bleed
into the next visitor's. CSS keeps only the always-on decoration (shutter halo, flash) and
the rules that hold elements hidden until an animation claims them.

## Exhibit-grade upgrade path

The wall is fed through `localStorage` plus `BroadcastChannel`, which means one machine, one
browser, and a 24-image cap (`js/store.js` drops the oldest entries rather than losing the
image a visitor just made when quota is hit). To run the wall on a different device or keep
images permanently, replace `list()` and `publish()` with calls to a small server — the rest
of the app never touches storage directly.

## Lineage

Fourth prototype in `AstroProto/`. The pipeline reasoning comes from
`FiltersGreyscale/web/index.html`, the multi-display + `BroadcastChannel` arrangement from
`FiltersNew/`, and the mirrored-capture and camera-selection lessons from `Filters/`.
