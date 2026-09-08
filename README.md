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
- Gallery wall → `https://localhost:5173/gallery.html` (one per monitor; open it four times)
- The earlier rows design → `https://localhost:5173/gallery2.html`
- Photos (view and delete) → `https://localhost:5173/admin.html`

**Both screens must be served by the same machine.** One computer runs this; the tablet opens the
interaction over the LAN and the wall opens the gallery — from that same server, at whatever
address reaches it. The pictures live on the serving machine, not in either browser (see
[The gallery wall](#the-gallery-wall)).

Chrome or Edge, full screen (F11). Vanilla JS, no framework — Vite is here for the dev server,
HMR and a bundled build, not for a component model.

## Running it on the exhibit machine

One computer serves everything and holds the visitors' pictures. Every other screen — the tablet
with the camera, the four gallery monitors — is a browser pointed at it. It does not have to be
the machine this was written on, and it does not need a checkout of anything else.

```bash
git clone https://github.com/Chagami/IsItReal-experiment.git
cd IsItReal-experiment
npm ci
npm run preview
```

`preview` serves the built copy in `dist/`, which is committed — so there is nothing to build on
the exhibit machine and nothing that can fail there for a reason that did not exist here. It
prints two addresses; the **Network** one is what the other screens open:

| screen | opens |
| --- | --- |
| the tablet | `https://<that machine>:4173/` |
| each gallery monitor | `https://<that machine>:4173/gallery.html` |
| whoever is running it | `https://<that machine>:4173/admin.html` |

Three things to know before the first opening.

**The certificate is self-signed**, so every client meets one "Your connection is not private"
screen: Advanced → Proceed. Once per browser, and then the camera works. The camera needs a
secure context and only `localhost` gets one for free, which is the whole reason for HTTPS here.
To lose the warning, swap `basicSsl()` in `vite.config.js` for `server.https` pointing at an
mkcert pair and install the mkcert root on each client.

**Give the machine a fixed address** — see below. The tablet's kiosk shortcut has the address
baked into it, and a DHCP lease that moves overnight is an exhibit that does not open.

**The pictures live on that machine and are not in git.** `wall/` is created on first use and
gitignored — a fresh clone starts with an empty gallery, and pulling never overwrites what
visitors have made. It is also the archive: every picture ever shared stays there even after it
scrolls off the wall, so it is the folder to back up and the folder to clear before an opening
(`admin.html` → Delete everything).

Updating later is `git pull` and restart. `npm ci` again only if `package-lock.json` moved.

### A name instead of an IP

`exhibits` works on this network because it is a record in the site's DNS, not a machine name:

```
exhibits  ->  exhibits.cssc.org  ->  192.168.66.56      (served by CSSC-DC1.cssc.org)
```

The bare word resolves because clients carry `cssc.org` in their DNS suffix search list. So
`sharedsky` is the same request to whoever runs that DNS:

> An **A record `sharedsky.cssc.org`** pointing at the exhibit machine, and that machine's
> address **reserved** so it does not move. Alongside it, a **certificate for `sharedsky` and
> `sharedsky.cssc.org`** from the internal CA.

Ask for the certificate in the same breath, because of this:

**`http://sharedsky` will not work for the tablet.** The camera is only available in a secure
context, and only `https://` and `localhost` count — over plain http `navigator.mediaDevices`
does not exist at all and the interaction cannot start. The gallery and admin screens have no
camera and would be fine on http, but running the exhibit on two schemes to save one certificate
is not worth the confusion. Use `https://sharedsky` for all of them.

A certificate from the site's own CA is the one worth having: domain-joined machines already
trust it, so nobody clicks through anything. Failing that, `mkcert -install` then
`mkcert sharedsky sharedsky.cssc.org` produces a pair, and its root has to be installed on every
client including the Android tablet — which is the fiddly one.

Then point the exhibit at the name, on the default https port so the URL carries no port at all:

```bash
set SKY_PORT=443
set SKY_CERT=C:\certs\sharedsky.crt
set SKY_KEY=C:\certs\sharedsky.key
npm run exhibit
```

`vite.config.js` reads those three. With a real certificate it drops the self-signed one; with a
path that does not exist it says so and falls back rather than failing to start. Vite reads the
names out of the certificate and prints them, so a correct setup announces itself:

```
➜  Local:  https://sharedsky/
➜  Local:  https://sharedsky.cssc.org/
```

Two more things on the machine itself: allow the port inbound through Windows Firewall
(`netsh advfirewall firewall add rule name="Share Your Sky" dir=in action=allow protocol=TCP
localport=443`), and set it to start on boot — a **Scheduled Task** at startup, running
`npm run exhibit` in the repo folder, set to restart on failure. That is the whole of what a
service manager would do here.

### Starting at boot

The exhibit has to come up on its own after a power cut, an overnight patch reboot, or somebody
switching the machine off at the wall on Sunday. Two scripts do it:

```
scripts\start-exhibit.cmd        the server itself
scripts\install-startup-task.ps1 registers it to run at boot
```

On the exhibit machine, once, from an **elevated** PowerShell in the repo folder:

```powershell
copy scripts\exhibit.env.example.cmd scripts\exhibit.env.cmd
notepad scripts\exhibit.env.cmd
powershell -ExecutionPolicy Bypass -File scripts\install-startup-task.ps1
```

`exhibit.env.cmd` is where the port and certificate paths go. It is deliberately not in git, so
a `git pull` never overwrites one machine's settings with another's. Without it the server still
runs, on 4173 with a self-signed certificate.

The installer registers a scheduled task called **Share Your Sky** running as SYSTEM at startup,
then starts it so you can check it without rebooting. SYSTEM rather than a named account for
three reasons: it starts with nobody logged in, it is allowed to bind port 443, and it has no
password to expire in the middle of a school holiday.

Two settings in there are worth knowing about, because both are failure modes that produce no
error message at all:

- **`ExecutionTimeLimit` is zero.** The default is three days, after which Windows kills the task
  and the exhibit goes dark with nothing in any log to say why.
- **The launcher restarts the server itself**, in a loop with a five-second pause, rather than
  relying on the task's restart-on-failure. That only fires when a task *fails*; a server that
  exits cleanly would otherwise stay down until somebody noticed.

To check on it: Task Scheduler shows the task, and `logs\exhibit.log` has what the server
printed, with the previous run kept alongside it as `exhibit.prev.log`. A line reading
`server exited with ... restarting in 5s` is the loop doing its job. `LastTaskResult` of 267009
in Task Scheduler means "still running", which is the healthy state.

To undo it, `install-startup-task.ps1 -Remove`.

**The screens are a separate problem.** The task serves the pages; it does not put a browser on
the wall, and it cannot — a browser needs a logged-in desktop session and SYSTEM has none. For
the gallery machine, set Windows to log in automatically and put a shortcut in
`shell:startup` along these lines:

```
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --kiosk https://sharedsky/gallery.html --edge-kiosk-type=fullscreen --no-first-run
```

**After a `git pull`**, restart the task (or reboot). `npm ci` again only if `package-lock.json`
moved. No build step: `dist/` is committed, which is also why editing anything under `js/` or
`css/` without running `npm run build` leaves the exhibit serving the old version.

### Is Docker worth it?

Not for this. There is nothing to isolate — no database, no system libraries, no version of
anything that has to be pinned beyond what `package-lock.json` already pins — and the whole
install is `npm ci`. Against that, a container on Windows means Docker Desktop has to be running
and healthy before the exhibit can start, which is one more thing that can be broken on the
morning of an opening. The camera never goes near it either: that is the tablet's browser talking
to the server over the network.

The problem Docker is usually reached for here is *keep it running and restart it if it dies*,
and on Windows a Scheduled Task does that with nothing to install.

It would start to earn its place with several exhibits sharing one machine, or the same image
deployed to more than one venue. If it comes to that, the pieces are: a Node base image, `npm ci`,
`CMD npm run exhibit`, the port published, and — the part not to miss — `wall/` bind-mounted to
the host, because it is the visitors' pictures and it must outlive the container.

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

**A hung `getUserMedia` is worse than a failed one.** On a wedged Android camera service the
call does not reject — it never settles at all. That produces no stream, no exception, no
message on screen and *no retry*, because a retry that lives in a `catch` is never reached: the
page simply parks. `openStream()` races every request against a 10s timeout so the call always
answers one way or the other, and if the real request turns up later its stream is handed
straight back rather than leaving the camera lit with nobody holding it.

**The camera is released on `pagehide`.** Nothing else does it. On a reload the browser is
supposed to free it when the old document is torn down, but that is a race the new document can
lose — and losing it means the fresh page asks for a camera the dying one still holds.
`pagehide` rather than `beforeunload`, which mobile browsers frequently decline to fire.

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
| `edit` | Their photo built up a colour at a time, the three channels it is made of beside it, and the two paragraphs that explain both | `Next`, once the picture is made |
| `adjust` | The picture alone and large with the question; then the same charts back, each with a spectrum across its top | `Share my sky`, once a colour has been moved |
| `confirm` | "Would you like to share your sky to the gallery?", the picture beside it | `No` / `Yes` |
| `astro` | The Pillars of Creation in step 2's exact arrangement, with the same three charts | `Start again` |

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

### Three of the four steps are sequences, not screens

Everything on steps 2, 3 and 4 arrives; nothing is authored in place. Each `STEP_ENTER` handler
is one async function, and reads in the order it happens.

**Step 2 — what the camera did.** Nothing to touch: the adjusting happens on the next screen.

1. The photo flies out of the viewfinder — FLIP, so what is animated is the difference between
   where it was and where it now is. It arrives **black**.
2. The sentence arrives **whole**, and fades in. It used to be typed a character at a time;
   reading speed is not typing speed, and a visitor who has finished the line is left watching
   the rest of it turn up. The line arrives at once and the *beats* carry the pacing instead.
3. Then each colour's name lights in turn, and **its own layer appears beside it** — the three
   channels stacking down the right. The frame stays black through all of this. The light is
   being taken *apart* here; putting it back together is the second paragraph's job, and doing
   both at once left nothing for the rest of the screen to say.
4. The second paragraph fades in **underneath the first, and both stay**. It used to appear only
   when somebody dragged a chart; there are no charts here any more, and waiting for a gesture
   that cannot happen would have left it invisible.
5. Then the sentence is acted out: each layer sends **a copy of itself flying into the frame**,
   red then green then blue, and the picture is built out of the three the visitor has just been
   shown. A copy, not the layer — the three stay where they are, so what is watched is the
   picture being assembled *from* them rather than them being used up. The composite only gains
   a channel when its copy lands, so the frame and the flight agree; the other order flickers
   black for a frame between the two.

   **The copies add rather than cover** (`mix-blend-mode: plus-lighter`), which is what light
   does and what makes the overlap seamless: a copy looks like the pure channel while it is over
   black, and like the two channels combined the moment it reaches the frame. Painted normally,
   an opaque copy of the green channel covered the red already in the frame, and for the length
   of the landing the picture showed green alone — the one frame of the whole sequence that was
   a lie about how light works. There is deliberately **no `z-index` on `.fliers`**: a stacking
   context would seal the copies off from what is under them, and seeing through to it is the
   entire point. They still paint on top because they are positioned and last in the markup.

   Measured: the frame reads `[0,0,0]` through the whole first half, then
   `[84,0,0] → [84,98,0] → [84,98,61]` as the copies land. The three layers read `[84,0,0]`,
   `[0,98,0]`, `[0,0,61]` — **they add up to the picture exactly**, because a layer is the same
   composite with the other two channels switched off rather than a separate drawing path. One
   place to change if the colours ever move, and a layer is provably a part of the picture
   rather than an approximation of one.

The frame's top edge and the first layer's top edge are **the same edge** — both columns start at
the same line. Centred, they missed each other by whatever the two columns differed in height,
which read as carelessness rather than as a pairing. Measured at 0px apart.

**Step 3 — the question, and then the means of answering it.** Two phases in one layout,
switched by `data-phase` on `#shareSplit`, so moving between them is one attribute and a FLIP
rather than a second screen:

5. `ask` — one column. Their photo flies up out of step 2's left column into the middle of the
   screen, half again as large as they have yet seen it, and the question types underneath in
   two sentences: what they did, and what to try next.
6. A second's pause, and then `tune` — the two-column split returns. The picture moves aside,
   the question moves with it, and the same three charts come back over the same three sets of
   numbers. The black and white points are still theirs to move, but each chart has grown a
   **spectrum across its top**: the colour a channel's light is shown in is now the variable,
   and it can be anywhere on the hue circle rather than one of three.
7. `Share my sky` is not offered until a colour has been moved *off its own hue*. Touching the
   strip and landing back where you started has not answered the question. It no longer shares
   anything either — it asks.

**Step 4 — the one question with a wrong answer.** Sharing is not a side effect of finishing the
adjusting, so it gets a screen of its own: *"Would you like to share your sky to the gallery?"*,
the picture beside it, and **No** or **Yes**. No starts the whole thing again and publishes
nothing; Yes publishes and goes on to the last screen.

The picture arrives by being **pulled out of shape and snapping back**: the first movement drags
the top left corner away — the origin is the opposite corner, so that corner is the only one that
travels — and the second lets go, snapping back to size and turning a full revolution about its
own centre. Two animations, not one, because they turn about different points and rotating about
the bottom right corner swings the picture off the side of the screen. Both are cancelled at the
end rather than left filling, because a full turn lands exactly where no transform would.

The charts carry **"Try moving the sliders"** over them, arriving with the first chart rather than
with the column so it is never a caption on an empty space, and the picture carries **"Your final
image"** — the only label on a picture in the whole piece, and it is there because by that screen
the visitor has four of their own pictures in front of them.

Each strip carries a **marker at the colour that light actually is** — a line through the
gradient with a dot of the channel's own colour beneath it. However far the picture gets pushed,
there is always something on screen saying where it started. The chart's heading keeps naming
the source (`Red`, `Green`, `Blue`) and its dot keeps the source's colour, because which
filter's exposure you are looking at does not change; only the colour it is drawn in does.

Colours are **free, not traded**. Two channels can be given the same hue and the picture is
still a picture, because the composite adds them.

### The composite

`drawComposite(canvas, frame, luts, tints)` is the whole model, and every screen uses it.
`tints[src]` is that channel's colour as weights on the three outputs — `hueTint(deg)`, which is
hsl(deg, 100%, 50%) with the algebra written out. The picture is the **sum** of the three tinted
channels, which is exactly what a narrowband composite is: one greyscale exposure per filter,
each assigned a colour, added together. Feed it the three primaries and the sum collapses back
to plain RGB, so there is no second code path and no "special" screen.

Two properties are worth not breaking:

- **The primaries are exact.** `hueTint(0/120/240)` is `[1,0,0]`/`[0,1,0]`/`[0,0,1]`, so an
  untouched picture comes out of the tinted path bit-for-bit identical to a straight channel
  copy — verified at zero difference across every pixel of a test gradient. Steps 2 and 4 depend
  on that; if it ever drifts, every screen in the piece shifts colour at once.
- **The lookup table follows the plane, not the output.** A channel's black and white points
  belong to the light it collected, wherever that light ends up on screen.

The nine 256-entry tables in there are not premature. Done directly this is nine multiplies a
pixel, 1.3 million pixels a frame, on a tablet, while a finger is moving; with each channel's
levels folded into a per-value table it is nine array reads, and the destination being a
`Uint8ClampedArray` means the sums clamp themselves. Measured at 1000×1333: **8.16ms a frame for
the primaries, 8.56ms for arbitrary hues** — the general case costs 5%, not double.

The chosen hues are stored with the shared image, because they are the one thing about a
visitor's picture that is a choice rather than a measurement.

**Step 4 — the famous photo:**

8. Opens blank, deliberately. The line about the gallery types on an empty screen, holds, and
   then rides up to the top as the two columns arrive underneath it.
9. The Pillars of Creation appears in step 2's place, and the same three charts arrive down the
   right, one at a time, each sliding its handles in off the ends of the track. **The whole
   arrangement is step 2's, reused unchanged** — that likeness is the argument the step is
   making, so if you restyle one, restyle both.
10. The explanation types where step 2's sentence was.

The nebula is `img/pillars.jpg` — ESA/Hubble `heic1501a`, the 2015 WFC3 revisit, public domain
with credit. Swapping it for another picture needs nothing but the file: its aspect ratio is
read from the image and written to `--pillars-ar`, and it is decoded and split into channels at
boot rather than on step 4, because doing that work while a visitor watches an empty screen is
exactly the wrong moment for it. **The credit line under it is not decoration** — it is somebody
else's photograph on a museum wall.

Steps 2 and 4 edit **different numbers over different pictures** (`levels` / `frame` against
`astroLevels` / `pillarsFrame`). `buildEditors` is given both, rather than reaching for module
state, so adjusting the nebula cannot quietly rewrite the picture the visitor already shared.

Three things are worth knowing before changing any of it:

- The sentence lives in `STORY`, as segments rather than as a string with markup in it. A
  segment carrying a `ch` is a channel's name, and the word is read from `CHANNELS` rather than
  written out again — so the sentence and the chart's own label cannot drift apart. The three
  beats are the same code three times, not three hand-placed callbacks.
- Beams are measured, never authored. Length and angle come from the word's rectangle and the
  chart's, so the beat survives any change to the layout above it.
- A button that is waiting its turn gets `.waiting`, not `hidden`. Hiding it outright shortens
  the dock, and because the steps above are vertically centred, the whole screen then shifts by
  half of what the dock lost — at the exact moment the visitor is being invited to look at it.
- The marks in the bar are **transparent**, and the rule between them stops at their edges rather
  than passing behind them. An opaque mark hides the blob completely — it sits behind them.
- **Which section is on screen is a class**, set by `goToStep`, not a stylesheet list of
  `body[data-step=x] .step[data-step=x]` pairs. That list stops matching the moment a step is
  renamed, and the failure is silent and total: the screen renders into a box zero pixels wide,
  so the pictures draw, the text is there, and none of it can be seen or touched.
- The histogram has **no numbers and no ramp line** — the handles and the shaded shoulders say
  everything the numbers did, without asking anybody to read a value off a wall.

Step 2 runs about eight and a half seconds, step 3 about eight, step 4 about nine. It is
`TIMELINE.typeChar` (26ms a character) that dominates all three; halve it and you halve the
wait everywhere.

Every pause is a `wait()`, which resolves only while the generation it was made in is still
current — so an abandoned turn cannot type its way into the next visitor's screen. It stops
where it stands.

### The bar and the dock

They are at opposite ends of the screen, and deliberately. The **bar across the top** says where
the visitor is: four numbered stations — `1. Photo`, `2. Adjust`, `3. Share`, `4. Channels` —
with a rule running between them and everything behind the current one greyed. It is context,
not a control, and nothing on it is pressable. The **one thing that is** sits alone at the foot,
where a hand already is; which button shows is derived from `STEPS[i].action`.

A step's station is `STEPS[i].mark`, kept separate from its position in the sequence because
they no longer line up. Step 2 has no controls left on it — it is the photograph being explained
— so it stands at **Photo** with step 1. **Adjust** is step 3, where the colours are actually
moved; **Share** lights for the moment between pressing the button and the last screen opening,
which is the only time sharing is actually happening. Without that the station would never be
the current one, and a station that is never current reads as a step that got skipped.

Riding along the bar is **one orange blob**. When the step changes it stretches across to the
next station and squashes as it lands.

Squash and stretch, not a gooey filter. A metaball pinch needs a blurred SVG filter over a
repainting element, which is one of the three things that behaves completely differently on the
exhibit's Android SoC than it does on a desk; a ball that elongates as it leaves and squashes as
it arrives reads as liquid just as well and never leaves the compositor.

Three things in `moveBlob` are load-bearing:

- **Its size and position are measured off the mark**, not computed from the column width, so
  it cannot drift if the bar is restyled. A `ResizeObserver` re-places it — without animating,
  because a blob sliding across because the window changed shape is a bug, not a transition.
- **The last trip is cancelled before the new resting place is written.** A finished animation
  with `fill: both` keeps painting its final keyframe, and an animation effect outranks inline
  style — so without the cancel the blob ignores every repositioning after its first journey.
  That is invisible until the screen changes size and the blob is left over the wrong mark.
- **The icon under it goes dark only once the blob has arrived** (`.dot.lit`, set from a timer
  at 72% of the trip), not when the step changed. Flipping it on the step change leaves a dark
  glyph on a dark ground for the length of the journey — invisible for exactly as long as the
  animation is trying to draw the eye to it.

`goToStep`'s `animate` and `blob` are separate switches. `animate` is the section's own fade,
which step 2 turns off because the photo's flight is its transition; the blob still has to
travel. `reset()` turns both off — "Start again" is not a transition, it is the piece ending.

### A camera mounted sideways

`?rot=90`, `?rot=180`, `?rot=270`, or the **Rotate camera** button in the debug menu. Set on the
machine rather than in the code, for the same reason `?cam=` is: which way the camera sits is a
property of the bracket it is screwed to, not of the exhibit.

The button turns it a quarter at a time and remembers the answer in `localStorage`, so an
installer can line the picture up on the machine itself instead of editing a shortcut. An
explicit `?rot=` still wins over what was remembered, and does not overwrite it — so a shortcut
can force a known orientation without destroying the machine's own setting.

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

- `js/main.js` — **every word the visitor reads**, in `STORY`, `STORY_AFTER`, `SHARE_STORY`,
  `ASTRO_LEAD` and `ASTRO_STORY`, near the top of the step-2 section. A segment marked
  `block: true` starts its own line after a pause. They are typed rather
  than rendered, so they live in the script and not in the markup.
- `index.html` — the structure of each step, and the credit line.
- `img/pillars.jpg` — the famous photo. Any image works; nothing is hard-coded to this one.
- `js/main.js` — the `TIMELINE` object at the top is the entire pacing of the piece in one block:
  countdown cadence, the didactic beats, the three reveal crossfades, the reset timings.
- `css/app.css` — `--shot-ar` is the photo's shape, set from the camera; which screen is on is
  decided by `body[data-step="..."]`. Step 2's two columns are `.edit-stage`.
- `js/levels.js` — the editor and the histogram drawing. Pass `hue` to give a chart the
  spectrum strip; without it a chart is simply its own colour and says so.
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

### The debug menu

The overlay above is a readout. The menu is the half that can be clicked:

| | |
| --- | --- |
| `?debug=1` | on from the URL |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> | on a machine with a keyboard |
| tap **1. Photo** five times, then **2. Adjust** | on the kiosk, with nothing plugged in |
| <kbd>Esc</kbd> | closes it |

A modifier rather than a bare key, because unlike the readout these buttons *do* things. It
holds **Rotate camera**, **Background glow**, **Perf overlay** and **Restart**, each showing its
current state beside the label.

The tap sequence uses the progress bar's own station marks. They have no behaviour of their own,
so a tap on one is already a no-op — which is what makes them safe to overload without taking a
press away from anything a visitor might want. It has to be a run: any other station, or a pause
over two and a half seconds, puts the count back to nothing, so idle prodding cannot leave the
exhibit armed for whoever touches it next.

The two overlays are deliberately separate objects. The readout must never be able to eat a
visitor's touch, so it stays `pointer-events: none` forever; the menu is interactive, which is
only safe because there is no way to open it by touching the screen. Nothing is built until
something asks for it, and the actions are registered by `js/main.js`, which owns the state they
change — `perf.js` has no idea what a camera rotation is.

Alongside the timings the readout reports the **build stamp**, the secure-context and
camera-permission state, the camera list with the `?cam=` index for each, and running
**node / canvas / heap** counts. Those last three are how you spot a leak on a machine you cannot attach a debugger to —
they should be flat across visitors, and a kiosk never restarts, so anything that grows has all
day to do it.

### Banding on the exhibit panel

The install screen showed flickering red and blue speckle in a ring around the live feed. Not on
a desk monitor, not on a flat black image, and nowhere else on the page. That combination is the
whole diagnosis.

It was `.live-frame`'s drop shadow: `0 30px 90px rgba(0, 0, 0, .65)`. Measured against the same
frame with the shadow removed, at its darkest it took the background from (6,7,10) to (4,4,6) —
**five levels out of 255**, averaging 1.47 across the band. Invisible. To buy that nothing it
laid a smooth ramp about 110px wide right around the frame, and 8-bit output quantises such a
ramp into about nine steps: a contour every twelve pixels, in a ring, exactly where the
viewfinder is. A patch of that ring held 9 distinct colours; with the shadow gone it holds 1.

Chrome draws all of this perfectly steadily — eight captures in a row came back bit-identical —
so the flicker was never the page redrawing. It is the panel. A display that cannot show every
8-bit level fakes the ones in between by alternating rapidly between its two nearest, and the
darkest few percent of the range is where that shimmer becomes visible. Give it nine adjacent
near-black levels in a band and it shimmers in a band.

**The rule that follows: no wide, soft, low-alpha shadows on the near-black ground.** A 1px
hairline defines these edges anyway, and it is one hard step rather than a ramp. The same shadow
was on `.pic` and went with it.

Removing the shadow was not the end of it. With the shadow gone *and* the glow off the ring
measured a single flat colour, and the panel still showed blue static — everywhere this time,
not in a ring. The reason is the ground itself.

`--bg` was `#06070a`, and blue 10 is the worst value in the neighbourhood. A 6-bit panel can
show 8 and it can show 12; ten is exactly halfway, so it displays 8 for half the frames and 12
for the other half, for ever. That was **60.1% of every dark pixel on the screen** alternating at
maximum amplitude — which is what blue static is. A flat black image never does it because 0 is
a level every panel can show exactly.

So the ground is now `#040408`: the same slight blue lean (blue four levels above red, as
before), every channel on a step such a panel displays exactly. Measured after the change,
**98.4% of dark pixels sit on `4,4,8`, steady**, and only 1.5% land on a level needing dither —
those being antialiased text and border edges, which are a pixel wide and not worth chasing.

**Ground** in the debug menu cycles `#040408 → #000000 → #06070a`, because which levels a given
panel can show is a fact about that panel, best settled in front of it. Pure black is the one
value no display has to dither.

The two `rgba(255, 255, 255, .04)` fades on `.dock` and `.topbar` went at the same time, for the
same reason: a ten-level ramp each, over a hairline border that was already doing the separating.

Two related things left deliberately alone:

- **The sky glow** behind everything is still on by default, and on this panel it should not be.
  It is a smooth gradient through the near-black range, so most of it lands between displayable
  levels: with it on, **57.7%** of dark pixels need dithering, against 1.5% with it off. That is
  the whole background shimmering. **Background glow** in the debug menu turns it off and
  remembers it. The default is unchanged only because the glow is a deliberate part of the look
  and is perfectly well behaved on an ordinary monitor — on the exhibit panel, turn it off.
- **The gallery's print shadows** stay. There the shadow falls on other prints as often as on
  the wall, which is real work rather than a black blur on a black ground. Worth re-checking on
  the wall panels, since the same defect would look the same.

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

## The gallery wall

Two designs, both live, so they can be compared on a real wall rather than in the abstract.

| | |
| --- | --- |
| `gallery.html` | **stacking.** Prints are laid down and never taken away; when a grid fills, a new one begins over it |
| `gallery2.html` | **rows.** Justified rows, one tile crossfading to something new every half minute |

What they share — joining the wall and holding pictures nobody else has — is `js/wallscreen.js`,
because that half is the server's protocol and not a design choice. Two copies of it would drift
out of step with `server/gallery.js` one at a time and only fail with four screens running.

### The stacking wall

Every picture arrives turning, into a place in the top grid. When that grid is full a new one
starts over it, leaning a little further forward, and the ones underneath stay and show at their
edges. Nothing fades and nothing is removed until it has been pushed four grids back.

**A grid's places are all decided the moment it is made, and then filled in a shuffled order** —
so pictures appear about the grid rather than marching along it. A wall filling left to right
reads as a progress bar; one filling at random reads as a wall. Measured over four fresh layouts:
every one a different order, all ten places used exactly once, none of them in reading order.

Each print remembers *which place* it took rather than the order it was hung, which is what keeps
it there when the stack re-leans or the window changes size. Matching prints to places by
position would have dealt everybody a different spot on every resize — verified: same places
before and after.

```js
tiles: 10,          // prints in one grid
layers: 4,          // grids kept; below that they are covered anyway
offset: 0.03,       // how far each grid leans from the one under it
addEvery: 30000,    // a picture is laid down this often
communityShare: 0.25,
border: 9,          // the black mount around every print
sizeRange: 2,       // the largest print in a grid, against the smallest
freshScale: 1.5,    // the newest visitor's picture, against the largest of the others
```

### Sizes

Prints are not all one size. Every grid deals its places sizes spanning exactly `sizeRange` —
**pinned, not sampled**, because drawing ten numbers out of a range gives whatever spread it
happens to give, and the wall came out looking uniform. One place is dealt the floor and another
the ceiling and the rest fall between, all drawn again for every grid, so **the biggest picture
is never in the same corner twice**. Measured over four thousand grids: largest ÷ smallest is
2.0000 every time, and which place gets it lands evenly across all ten (10% each).

The sizes are normalised on **area**, not on width, so a grid of mixed sizes covers about as much
wall as a grid of equal ones — normalising on width would have grown the total by half. Measured:
mean area 1.0000 against uniform. On screen that is prints from about 270px to 650px wide.

The newest visitor's picture is `freshScale` times **the largest of the other visitors'
pictures**, not times its own place. The places are different sizes now, and landing in a small
one must not make the newest picture on the wall smaller than one somebody left twenty minutes
ago. Measured after a share: 1.50× the biggest other.

One consequence worth seeing before it ships: the larger prints overlap their neighbours rather
than sitting inside their own cell. On a wall of stacked, black-mounted prints that reads as a
pile — which is the point — but it is a real change from the tidy grid, and `sizeRange: 1` turns
it off entirely.

Every print gets a **black mount**. On a near-black wall it does almost nothing on its own —
what it is for is the moment two prints overlap, where it is the edge that says which is on top.

The **newest visitor's picture** is half again the size of the other visitors' pictures and turns
a full revolution coming in, where an ordinary print turns about fifteen degrees. Larger by
transform rather than by taking a bigger slot, so the grid underneath is untouched and it simply
overlaps its neighbours — which on a wall of stacked prints is what being on top of the pile
looks like anyway. Position and size are the same transform, so neither costs a reflow.

Nothing is cropped here either: `object-fit: contain` inside a uniform cell, and the column count
is chosen to bring a cell's shape near the pictures' own, because a landscape photograph in a
tall cell is mostly black mount.

### Keeping the visitors' share on a wall that only grows

Every submission goes up the moment it is made — that is the promise the exhibit makes to the
person who just pressed the button, and it is not negotiable against a ratio. So the ratio is
kept from the other side: a quarter share means three curated pictures for each one of theirs,
laid down around it. A busy evening simply fills the wall faster.

Measured, one visitor at a time — which is what an exhibit actually does:

| shared | prints | visitors' | share |
| --- | --- | --- | --- |
| 0 | 10 | 0 | 0% |
| 1 | 11 | 1 | 9% |
| 2 | 12 | 2 | 17% |
| 3 | 13 | 3 | 23% |
| 4 | 16 | 4 | **25%** |

A *rush* is different. Twelve submissions inside two seconds takes the wall to about 43%, and it
cannot come straight back down: the wall holds forty prints, so twelve of theirs is thirty
percent of it whatever else goes up. It settles as the pile rolls over. That is honest behaviour
for a participatory wall and worth knowing rather than fixing.

### This design eats pictures

The rows wall holds seven curated pictures per screen and changes one every half minute. The
stacking wall lays down a new one every half minute and keeps forty. Four screens running for an
hour want a couple of hundred distinct pictures to never repeat; the folder has thirty, so it
repeats heavily. **If the stacking design is the one that ships, `img/sky/` needs to be several
times larger** — see below.

### Four screens that do not repeat each other

No screen can know what its neighbours are showing, so the server keeps the register —
`server/gallery.js`:

```
POST api/gallery/join   { want }         join, and get `want` pictures nobody has
POST api/gallery/beat   { id }           still here
POST api/gallery/swap   { id, retire }   give one back, take a fresh one
POST api/gallery/leave  { id }           done
GET  api/gallery/state                   who is on the wall and what they hold
```

Allocation prefers what nobody holds, then what has been shown least, so a wall running all day
works through the whole folder rather than orbiting the same dozen. Only when the wall wants more
pictures than exist does it repeat — and then it repeats the rarest. Verified: four screens
joining at once took **32 distinct pictures out of 32**, no duplicates.

A screen that vanishes — unplugged, crashed, closed — stops beating and its pictures return to
circulation after 45 seconds. A museum wall runs unattended for twelve hours; anything needing a
person to tidy it up will not get tidied.

### The visitors' pictures

A quarter of each screen (`communityShare`), interleaved through the wall rather than blocked in
a corner. Ten and a quarter share is two and a half pictures, which is not a number of pictures,
so it rounds up: **three of ten**. Erring towards the visitors rather than away from them is the
point of the exhibit.

The share is filled as pictures arrive, and the wall is always full while it fills:

| shared so far | tiles | visitors' |
| --- | --- | --- |
| 0 | 10 | 0 |
| 1 | 10 | 1 |
| 2 | 10 | 2 |
| 3 or more | 10 | 3 |

That needs the count *before* the curated pictures are asked for, which is why `join()` reads the
gallery first. Asking first left the wall short — on a morning with nothing shared it reserved
three slots for pictures that did not exist and hung seven pictures instead of ten.

Growing the share while the wall is up means re-dealing, and that is the one time the layout
moves. It only happens for the first few of the day: every visitor's picture is the same shape as
every other, so once a slot of that shape exists the next one drops straight into it — but making
the *first* one needs a slot that is not there yet, and nothing is cropped to force it.

**The newest is on every screen** — a visitor who has just shared is being told to go and look,
and finding it should not depend on which of four monitors they walk to. Beyond the newest, each
screen strides through the list by its own slot number, so no two agree.

When somebody shares, the oldest community tile takes the new picture and arrives with a light on
it. Not a rebuild: one tile changes, the layout does not move, and the glow is how the person who
made it finds it from across the room. Verified — exactly one tile goes `fresh`, and it is always
a community tile.

Kept per picture: the colours they gave each channel, and when. No names, no captions.

### The curated pictures

**Drop them in `img/sky/`.** That is the whole procedure: any filename, any of jpeg, png or webp.
The server reads the folder itself and takes each picture's dimensions out of its own header —
the screens need those to lay out before the pictures have loaded. It re-reads whenever the
folder's timestamp changes, so pictures can be added or taken away while the wall is running and
the screens pick it up on their next swap. No script, no manifest, no rebuild.

It did require a `manifest.json`, and that was a trap: a folder full of pictures with no manifest
showed a wall of black rectangles, which is exactly what dropping pictures into a folder gets you.
Filenames were restricted to `[a-z0-9_-].jpg` too, which refused every hand-curated file — real
ones have spaces and brackets and photographers' names in them. Pictures are now served from an
allowlist of what the scan found, which permits any name and is the stricter check anyway: `..`
is not the name of a picture in the folder.

They are served by the middleware rather than from `public/`, which would copy the whole folder
into `dist/` on every build — and `dist/` is committed.

**How many to put in there.** Four screens holding seven curated pictures each is 28 in use at
once. The folder has 30, which leaves **two** that nobody is holding — and those two are the only
things a rotation has to bring in, so the wall cycles the same pair every half minute. For a wall
that does not visibly repeat itself, the folder wants to be about twice what is on it: **sixty or
more**. Verified: four screens take 28 distinct pictures out of 28, with nothing left over.

```bash
npm run sky        # optional: top up from NASA's image library
```

That never touches what is already there. Two things before running it: the search is
indiscriminate — artists' impressions and diagrams come back alongside photographs — and NASA
imagery being "generally public domain" is a general statement, not a licence. Both want a human
pass. It writes `CREDITS-nasa.txt`, which covers only what it fetched.

**Attribution is not handled.** The wall shows no captions by design, and the pictures now in
`img/sky/` are individual photographers' work with their names in the filenames. If the exhibit
needs to credit them on screen, that is a change to make — the names are already there to read.

## Where the visitors' pictures live

The exhibit is **two devices**: the interaction on a tablet over the LAN, the wall on a screen
somewhere else. So the pictures live on whichever machine serves the pages, in `server/wall.js` —
a Vite middleware rather than a second process, so the exhibit is still one command to start.

```
GET    api/wall               the newest pictures, newest first
POST   api/wall               publish one { image: dataURL, levels, shownHue }
GET    api/wall/stream        server-sent events: a picture arrives as it is made
GET    api/wall/img/<id>.jpg  the picture itself
DELETE api/wall               empty the wall
```

Pictures are written to `wall/` as ordinary `.jpg` files with an `index.json` beside them. The
wall shows the newest 24; **every picture ever shared stays in that folder**, so a day's visitors
can be recovered from it afterwards. The folder is gitignored — it is data, not source.

### Why it is not localStorage

It was, and it could not have worked. `localStorage` is scoped to one origin in one browser, so
`https://localhost:4173` and `https://192.168.1.20:4173` are two separate walls served by the
same machine — and two separate machines share nothing at all. Proven rather than assumed: writing
at one hostname and reading at the other returned two different one-item walls.

That is also why the store kept images as base64 data URLs, a third larger than the bytes they
carry, against a quota of about 5MB. Twenty-four of a real capture is six to nine megabytes, so
the wall silently dropped the oldest while claiming to show twenty-four. Files on disk have
neither problem.

### It still works when the wall machine does not

`localStorage` is kept as the fallback, and this is the part not to break: **a visitor pressing
Share must never wait on a network and must never lose their picture.** `publish()` is not
awaited, resolves either way, and keeps the picture on the tablet if the server cannot be
reached; the turn carries on identically. Where it actually went goes to the debug overlay
(`shared`), because that is a question for whoever is running the exhibit, not for the person
standing in front of it. Verified by blocking `api/wall` outright mid-visit: step 4 still ran, the
picture was still kept, and the wall on that device still showed it.

The wall keeps itself current three ways, because a picture that never appears is the one fault a
visitor actually notices: the event stream, a 60-second poll behind it as a backstop for a stream
that died quietly, and `BroadcastChannel` for the offline case where both screens are one browser.

### The photos page

`admin.html` is for whoever runs the exhibit: every picture ever shared, newest first, with when
it was taken and whether it is currently on the wall or has scrolled off into the archive. It
asks the store for `?all=1` rather than the wall's newest 24 — the picture somebody wants taken
down is as likely to be one visitors can no longer see.

Click a card to select it (the whole card, not a checkbox — this gets done on a tablet). The ×
on a card removes just that one. The toolbar deletes the selection, or everything.

**Every destructive button asks twice.** The first press turns the button itself into a red
warning saying exactly what is about to happen; the second press does it, and it disarms on its
own after four seconds so a half-pressed button cannot be finished by somebody walking past. Not
a modal — an operator standing at a kiosk dismisses those without reading them. Deleting is
permanent and reaches an open wall live, through the same event stream a new picture arrives on.

It is **linked from nowhere** and **not authenticated**. On a staff LAN with no route in from
outside that is the right trade: a password here is a thing for a technician to lose, not a
defence. If the exhibit ever shares a network with the public, this page needs a door on it.

### When the wall is empty

It says why, in the same quiet register as the camera's service note: which address it is, whether
it can reach the store, and whether the local fallback is usable. "No skies shared yet" is true
both when nobody has used the exhibit and when the wall is looking somewhere nothing is written,
and those need completely different fixes.

## Still to do

Hand a visitor a QR code for their own picture; put the wall behind a real host name so the
tablet's kiosk shortcut does not carry an IP address; put a door on `admin.html` if the exhibit
ever shares a network with the public; let a visitor put a name to their picture.

## Lineage

Fifth prototype in `AstroProto/`, forked from `IsItReal`. The levels/histogram reasoning goes back
to `FiltersGreyscale/web/index.html` (black point, contrast and brightness as a shared tone LUT),
the multi-display arrangement to `FiltersNew/`, and the mirrored-capture and
camera-selection lessons to `Filters/`.
