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

## Where it stands

As of September 2026, the whole visitor path runs end to end on the exhibit machine:

- **Photo.** A countdown takes the picture. The camera is asked for 4K first and steps down to
  1080p, then to whatever it offers, if a size doesn't open or sends no frames.
- **Adjust.** The picture is built up one colour at a time, and then comes the first question:
  *is this image real?* The visitor answers by walking a figure along a No-to-Yes scale.
- **Colours.** A filter wheel on the right of the picture (Red, Green, Blue, and the camera's own
  RGB) turns with a swipe. The black and white points can be dragged for each channel, and then
  the question is asked again of the edited picture.
- **Share.** The picture goes to the gallery wall.
- **Reality.** Everybody's answers so far, before editing against after, with the visitor's own
  two answers marked.

Both answers are logged to `data/answers.csv` on the serving machine. The admin page can
download that file or clear it.

On the kiosk, the debug menu opens with five taps on **1. Photo** and then one on **2. Adjust**.
It closes with the **×**. From it you can rotate, crop and pad the picture to fit the housing,
choose the camera resolution, and choose a denoise mode.

Open items, all on the hardware side, are under [Still to do](#still-to-do).

## Run

```bash
cd IsItReal-experiment
npm install
npm run dev
```

- Interaction screen → `https://localhost:5173/`
- Gallery wall → `https://localhost:5173/gallery.html` (one per monitor; open it four times)
- Photos (view and delete) → `https://localhost:5173/admin.html`

**Both screens must be served by the same machine.** One computer runs this; the tablet opens the
interaction over the LAN and the wall opens the gallery — from that same server, at whatever
address reaches it. The pictures live on the serving machine, not in either browser (see
[The gallery wall](#the-gallery-wall)).

Chrome or Edge, full screen (F11). Vanilla JS, no framework — Vite is here for the dev server,
HMR and a bundled build, not for a component model.

## Running it on the exhibit machine

One computer — a Linux box — serves everything and holds the visitors' pictures. Every other
screen, the tablet with the camera and the gallery monitors, is a browser pointed at it with
nothing installed. Work happens on a dev machine, is pushed to GitHub, and the exhibit machine
only ever pulls.

```bash
git clone https://github.com/Chagami/IsItReal-experiment.git
cd IsItReal-experiment
npm ci
sudo scripts/install-service.sh
```

That is the whole install. `install-service.sh` registers a systemd service called
**sharedsky** that starts at boot and restarts if it stops, copies `scripts/exhibit.env.example`
to `scripts/exhibit.env` for you, and leaves a `sudoers` rule so the update script can restart
the service over ssh without a password prompt it could not answer. It runs as whoever invoked
`sudo`, not as root.

There is no build step: `dist/` is committed, so a fresh clone serves immediately and nothing
can fail on the exhibit machine for a reason that did not exist here. (The flip side: editing
anything under `js/` or `css/` needs `npm run build`, or the exhibit goes on serving what was
committed.)

Then set the port in `scripts/exhibit.env` — it is deliberately not in git, so every machine
keeps its own and a pull can never overwrite it:

```
SKY_PORT=80
SKY_HTTP=1
```

Port 80 is what makes the address plain `http://sharedsky` with nothing after it. Binding a port
below 1024 as a non-root user is what `AmbientCapabilities=CAP_NET_BIND_SERVICE` in the unit
file is for. `sudo systemctl restart sharedsky` after editing.

| | |
| --- | --- |
| logs | `journalctl -u sharedsky -f` |
| state | `systemctl status sharedsky` |
| stop it starting at boot | `sudo scripts/install-service.sh --remove` |
| run it in the foreground instead | `scripts/exhibit.sh` |

**The pictures live on that machine and are not in git.** `wall/` is created on first use and
gitignored — a fresh clone starts with an empty gallery, and pulling never overwrites what
visitors have made. It is also the archive: every picture ever shared stays there even after it
scrolls off the wall, so it is the folder to back up, and the folder to clear before an opening
(`admin.html` → Delete everything).

### Updating it from the dev machine

Everything is pushed to GitHub from wherever it was written; the exhibit machine only ever
pulls. One line, over ssh:

```bash
ssh exhibit@sharedsky '~/IsItReal-experiment/scripts/update.sh'
```

`update.sh` fetches, fast-forwards, and restarts the service, printing what it did at each step
so a run over ssh is legible rather than silent. Three things it deliberately will not do:

- **It will not pull over local edits.** Uncommitted changes on an exhibit machine are nearly
  always accidental, but throwing them away unasked is worse than stopping — they might be the
  fix somebody made at the wall on a Saturday. It prints `git status` and exits non-zero.
- **It will not merge.** `--ff-only`, so a checkout that has drifted stops rather than making a
  merge commit on a machine nobody is looking at.
- **It will not reinstall dependencies for nothing.** `npm ci` deletes `node_modules` and takes
  a minute, so it runs only when `package.json` or `package-lock.json` actually moved between
  the two commits.

If the service does not come back within three seconds of the restart it prints the last 25
journal lines and exits non-zero, so a broken deploy fails the ssh command rather than looking
like a success.

### A name instead of an IP

`exhibits` works on this network because somebody made a DNS record for it. It is not a machine
name and nothing on the exhibit PC creates it:

```
exhibits  ->  exhibits.cssc.org  ->  192.168.66.56      (served by CSSC-DC1.cssc.org)
```

The bare word resolves because clients carry `cssc.org` in their DNS suffix search list, so
`sharedsky` is the same request to whoever runs that DNS:

> An **A record `sharedsky.cssc.org`** pointing at the exhibit machine, and that machine's
> address **reserved in DHCP** so it cannot move overnight.

Nothing in this repo can do that part. Until the record exists, every screen has to use the IP.

**The one catch, and it decides whether you also need a certificate.** `getUserMedia` only
exists in a secure context, and plain `http` is not one unless the host is literally
`localhost`. So over `http://sharedsky`:

| page | camera | works over plain http? |
| --- | --- | --- |
| `gallery.html` | no | yes |
| `admin.html` | no | yes |
| the visitor interaction | **yes** | **no — `navigator.mediaDevices` is undefined** |

Three ways round it, in the order I would try them:

1. **Tell the tablet's browser to trust that one origin.** Chrome and Edge have a setting for
   exactly this: `chrome://flags` → *Insecure origins treated as secure* → add
   `http://sharedsky`, enable, restart. The camera then works over http with no certificate
   anywhere. It is per-device and as unsafe as it sounds on a general-purpose machine — which a
   locked-down exhibit tablet is not. This keeps `http://sharedsky` for everything.
2. **A certificate from the site's internal CA**, issued for `sharedsky` *and*
   `sharedsky.cssc.org`. Domain-joined clients already trust that CA, so nobody clicks through
   anything. Then drop `SKY_HTTP` from `exhibit.env`, set `SKY_PORT=443`, and point `SKY_CERT`
   and `SKY_KEY` at the pair. A certificate for an IP address will not do, which is half the
   reason for wanting a name.
3. **mkcert**, if the internal CA is not available: `mkcert -install` then
   `mkcert sharedsky sharedsky.cssc.org`. Its root then has to be installed on every client,
   and the Android tablet is the fiddly one.

Also allow the port inbound on the exhibit machine's firewall. **That machine runs firewalld**,
not ufw: ufw is installed but inactive, so `ufw status` says nothing useful while firewalld
quietly rejects everything on the Wi-Fi except SSH. That looks exactly like a network problem,
and it is not.

```bash
sudo firewall-cmd --get-active-zones                     # the zone the network adapter is in
sudo firewall-cmd --zone=public --add-service=http --permanent
sudo firewall-cmd --reload
```

A second adapter, Ethernet added later say, can land in a different zone and needs the same.

### The screens

Every screen is a browser pointed at the one machine. Nothing else is installed anywhere.

| screen | opens |
| --- | --- |
| the tablet with the camera | `http://sharedsky/` |
| gallery monitor 1..n | `http://sharedsky/gallery.html` |
| whoever is running the exhibit | `http://sharedsky/admin.html` |

**The gallery monitors all open the same URL.** They sort themselves out: each one joins a
register on the server, is given a slot number and a hand of curated pictures nobody else is
holding, and says it is still there every twelve seconds. A screen that stops saying so is
forgotten after 45 seconds and its pictures go back in the pool, so a monitor that is unplugged
or reloaded does not strand a third of the folder. Measured with four screens asking for six
pictures each: 24 handed out, 24 distinct, zero overlap on any pair.

Open them in kiosk mode from each monitor's own machine, or from one machine with a window per
display:

```bash
chromium --kiosk --noerrdialogs --disable-infobars http://sharedsky/gallery.html
```

The visitors' own pictures are handled separately and are *meant* to repeat: every screen shows
new arrivals, because a picture that appeared on only one of four monitors would be missed by
the person who just made it.

One limit worth knowing before opening night: `img/sky/` holds **97** curated pictures, and the
stacking wall lays a new one down every 30 seconds per screen. Four screens exhaust that pool
within minutes and begin repeating. It wants a few hundred.

### Is Docker worth it?

Not for this. There is nothing to isolate — no database, no system libraries, no version of
anything that has to be pinned beyond what `package-lock.json` already pins — and the whole
install is `npm ci`. Against that, a container on Windows means Docker Desktop has to be running
and healthy before the exhibit can start, which is one more thing that can be broken on the
morning of an opening. The camera never goes near it either: that is the tablet's browser talking
to the server over the network.

The problem Docker is usually reached for here is *keep it running and restart it if it dies*,
and systemd does that with nothing to install — which is what `scripts/install-service.sh` sets
up.

It would start to earn its place with several exhibits sharing one machine, or the same image
deployed to more than one venue. If it comes to that, the pieces are: a Node base image,
`npm ci`, `CMD scripts/exhibit.sh`, the port published, and — the part not to miss — `wall/`
bind-mounted to the host, because it is the visitors' pictures and it must outlive the
container.

### Why HTTPS

This is about the **dev machine**. On the exhibit machine the scheme is a deployment choice with
its own trade-off — see "A name instead of an IP" above.

The camera API is only exposed in a **secure context**. `localhost` is the one plain-http origin
that qualifies; open the LAN address over `http://` and `navigator.mediaDevices` is not merely
blocked, it is undefined. So the dev server runs TLS by default
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

`dist/` is **committed**, so a clone serves on the exhibit PC with no build step — but that
means it can go stale. Rebuild and commit it in the same commit as any change to `js/`, `css/`
or the HTML, or the deployed copy will quietly lag the source. (Node is still needed there: it
is what serves the folder.)

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

### How much to ask a camera for

Asking for 4K is deliberate. `ideal` is a preference the browser satisfies as closely as it can,
and this used to ask for 1280x720 — which every camera worth having can do *exactly*, so every
camera did and a better sensor bought nothing.

But `ideal` only promises not to fail. It says nothing about **how long** the driver will take to
negotiate, or whether what comes back is a format the browser can actually decode — and a 4K HDR
camera can lose on both counts while a 1080p request to the same camera opens instantly. So it is
a ladder:

```
4K (3840x2160)  ->  1080p (1920x1080)  ->  whatever it offers
```

A rung that refuses, times out, **or opens and then sends no picture** is climbed down from
inside the same attempt. The last of those is the one that has no error attached to it: the
camera hands over a track that is live, unmuted and enabled, and never sends a frame. From the
page that is indistinguishable from a dark room until you notice `videoWidth` is still 0, which
is why `waitForFrames` exists and why it is `videoWidth` that it tests.

The kiosk shortcut can pin the top of the ladder:

```
?res=1080        never ask this camera for 4K
?res=any         ask for nothing in particular
?res=2560x1440   start there instead
```

**Never two `getUserMedia` calls in flight at once.** This is the rule the whole of `openStream`
exists to keep. A request that has been given up on is *still open in the driver*, and asking for
a second stream while the first is being negotiated is how a slow camera becomes a dead one — on
Windows the late answer arriving and being stopped tears the device down underneath the stream
that replaced it. So a request that times out is handed on rather than killed: `slowRequest`
holds it, and the next attempt takes whatever it eventually produced (`claimSlowRequest`). If it
is *still* negotiating when the next attempt comes round, that attempt throws rather than adding
another request to the pile, and the page's own retry tries again in fifteen seconds.

Measured against a stubbed camera that takes twenty seconds to answer: one request, and the
stream it finally produced is the one the exhibit uses. The version before this asked twice,
settled for a 640x480 fallback at ten seconds, and then stopped the 4K stream when it arrived.
Against a stubbed camera that opens at 4K and sends nothing: it steps down and opens at 1080p.

### Noise, and what this code does about it

**Nothing here creates any.** The capture resamples with the browser's own filter rather than
nearest neighbour, and every smaller copy is a box average — both of those *reduce* noise. The
one place it gets worse is the levels: the handles open on the 0.5th and 99.5th percentile of
each channel, and stretching that range to fill 0–255 multiplies everything inside it, noise
included, by **255 / (white − black)**. The dimmer the room, the narrower the range the sensor
actually used, and the bigger that number. The overlay reports it per channel as `levels gain`
on every capture, so a grainy picture can be settled either way by reading it: on the bench card
it is 1.14× and the noise measured 14.9 against a source of 12, which is the gain and nothing
else.

So the rest is the sensor, and the **Denoise** button in the debug menu offers two ways at it.

**Stacking** takes several frames and averages them. The noise is different in every frame and
the picture is the same in all of them, so the noise divides by the square root of how many
there were and the picture is untouched — no detail is softened, because no pixel is ever mixed
with its neighbours. It is what every photograph of the kind this exhibit is about was made
from. The cost is that the subject has to hold still for a fraction of a second, which is what a
countdown already asks of them.

**Smooth** is a sigma filter: each pixel becomes the average of the neighbours already close to
it in value, and anything further away than the tolerance is not counted. In a flat area that is
a nine-pixel average; on an edge, only the neighbours on the same side of it qualify, so the
edge is averaged along rather than across and stays put. That is the difference between this and
a blur, and the reason a blur is not offered. For one frame of a subject that will not hold
still.

**The tolerance is a multiple of the frame's own measured noise, not a number of levels.** A
fixed one cannot work: the first attempt used 12 levels against a sensor spreading 15, so almost
no neighbour qualified and the filter did nothing — it took the noise from 14.9 to 13.3. At two
and a half times the noise the frame actually has, the same filter takes it to 6.8.
`estimateNoise` measures that from the median difference between neighbouring pixels, a median
rather than a mean so the picture's own edges do not drag it up.

Measured against a test card that is half flat grey and half checkerboard, with fresh noise on
every frame (σ 12), reading the spread of the flat half off the finished composite:

| Denoise | noise left | sharpest edge | cost at 3.8 MP |
| --- | --- | --- | --- |
| off | 14.9 | 255 | — |
| stack 4 | 7.5 | 245 | 66ms + 4 frames |
| stack 8 | 5.5 | 252 | ~130ms + 8 frames |
| smooth | 6.8 | 250 | 846ms |
| stack 4 + smooth | **3.2** | 255 | ~0.9s + 4 frames |

The edge column is the point of it: a blur would have collapsed that number, and none of these
do. `smooth` is the expensive one — 846ms at a 4K capture capped to 2600px, against 226ms at
1080p — and it is spent once, at the shutter, behind the flash.

**Camera resolution** is the other new button, next to it. The choices are `split` (the
default, below), `ladder` (4K throughout, climbing down if it has to), `4k`, `1440`, `1080` and
`720`. Apart from `split`, these are the same values `?res=` takes. The choice is remembered
across a restart, so a camera that has to be told once can be told from the screen rather than
by editing the kiosk shortcut. A `?res=` on the shortcut still wins over `split`. Changing the
setting stops the running camera before opening the next one: assigning a new `srcObject` does
not stop the old tracks, it only stops showing them.

### A small live picture, a big photograph

At 4K the exhibit machine spent more than a whole CPU core in Firefox, all day, just decoding
the camera, and a browser with no time to spare is what tears frames. The viewfinder doesn't
need 4K: it's shown about 2000 pixels across, and nobody can tell while it moves. Only the
photograph does.

So in **`split`** the camera runs at **1080p**. That's roughly half the decoding: 1080p at 60fps
is 124 million pixels a second, against 249 million for 4K at 30. When the countdown starts,
the camera switches to **4K**, which gives the switch the whole 4.5 seconds of countdown to
happen in. It drops back to 1080p as soon as the picture is taken, or if the piece restarts
mid-countdown.

- **The switch retunes the running track first** (`applyConstraints`): it never lets go of the
  camera, and took about 0.4s in testing. If the browser refuses, or says yes and nothing
  changes within 3s, the camera is reopened at the new size instead, which took about 0.8s.
- **The photograph waits for the switch** if it hasn't finished, so it's never taken at the
  wrong size by accident. If 4K won't come at all, it's taken at whatever is running: a visitor
  must never lose the picture over a resolution.
- **Every switch goes through one queue** (`queueCamera`), so two changes are never in flight
  on the same camera at once. That's the rule `camera.js` is built around.
- The overlay's **camera switch** line says what the last switch did and how long it took, for
  example `4k: retuned in 432ms`.

What it's worth on the exhibit machine is still to be measured. Compare Firefox's CPU in `top`
between `split` and `ladder`.

**A fault this turned up, fixed at the same time.** `openStream` gives `getUserMedia` 16 seconds
before treating it as a slow request, and it never cancelled that timer when the camera
answered. So 16 seconds after every successful open, the timer filed the live stream away as a
request still in the air. The next open, a resolution change for instance, then adopted that
stream, which by then had been stopped, and showed nothing. That was "switching to 4k shows no
video".

### 4K in Firefox on Linux

**By default, Firefox on Linux cannot offer a page anything above 1920x1080, from any camera.**
Its camera code (libwebrtc's `device_info_v4l2.cc`) does not ask the device what it supports.
It tries a fixed list of 13 sizes, and the largest is 1920x1080. So on the exhibit machine both
`ladder` and `4k` settled on 1080p, while `v4l2-ctl` streamed the same camera at 3840x2160 MJPG
at 30.7fps with no complaint. Chromium-based browsers don't use that list.

Firefox's other camera path, through PipeWire, reads the real modes from the device, MJPG
included. To switch to it, set `media.webrtc.camera.allow-pipewire` to `true` in
`about:config`, then restart Firefox. The camera permission then comes from Ubuntu in a system
dialog, not from Firefox. Check that it survives a reboot before relying on it in kiosk mode.
This is what got the Arducam B0589 to 4K30 in Firefox.

### Torn frames

At 4K in Firefox, the bottom of the viewfinder flashed now and then with a frame whose lower
part was garbage. **The camera wasn't sending them.** ffmpeg decoded 534 frames of the same
stream without a single warning. They go wrong inside the browser, most likely because it is
short of CPU: ffmpeg itself could only decode that stream at `speed=0.937x` on this machine.
So nothing upstream can switch them off. `uvcvideo nodrop=0` only drops frames the *driver*
knows are incomplete, and there are none. `?fx=lite` didn't help either.

`js/frameguard.js` catches them in the page. **Frame guard** in the debug menu sets how much it
covers:

| mode | what it protects | cost |
| --- | --- | --- |
| `viewfinder + photo` (default) | the screen and the photograph | a few ms a frame, shown in the overlay |
| `photo only` | the photograph | about 70ms on the shutter, nothing otherwise |
| `off` | nothing | none |

**How a torn frame is told from a real change: it is an outlier in time.** Real motion carries
on into the next frame, so the frames either side of it differ from each other at least as much
as either differs from it. A torn frame doesn't: the frame before and the frame after agree
with each other, and it agrees with neither. Each frame is shrunk to 160 pixels wide and
compared in 16 bands. Each band is split into 8 cells, and a band counts as torn only when at
least 6 of its cells are. A tear runs the full width of the picture; a hand moving through the
bottom of it doesn't. A band only counts if it touches the bottom edge, or joins it through
other torn bands.

**The viewfinder becomes three canvases in rotation.** The video goes on playing underneath,
invisible. One canvas shows the frame on screen, one holds the frame waiting to be judged, and
one holds the frame that just arrived, which the waiting one is judged against. A torn frame
is simply never shown. Each frame is drawn once, at the size the viewfinder shows it, never
larger than the camera sends. The cost is being one frame behind, 33ms at 30fps. If frames
stop arriving while the video is still playing, a watchdog gives the screen back to the video
within a second, so the viewfinder can't be left frozen.

**Each frame of the photograph is checked the same way,** on a copy of the frame, so the frame
checked is the frame used. That includes every frame of a denoise stack, so a stack of eight
can't average a torn frame into the picture. The shutter gets twice as many tries as frames
wanted, plus four. If none of those pass, it uses the last one anyway: a stream torn on every
frame is a camera problem, and a photograph of it is still better than none.

The overlay line **frame guard** counts what it catches, on screen and in photos, shows the
cost per frame, and describes the last catch (how much of the bottom was bad, and by how much).
Tested against a synthetic camera with a hand sweeping across the bottom of the picture:

| | frames torn | caught |
| --- | --- | --- |
| motion only, 8s | 0 | 0 false alarms |
| bottom 11–39% filled flat green | 27 | all |
| bottom 11–39% filled with random noise | 28 | 20–23 |
| every other frame torn, while taking an 8-frame stack | about half | all 6–7 the stack came across; 8 clean shots used |

Random noise is the hard case, and probably a worse case than the real one: shrunk to 160
wide, it averages to mid-grey, which on a mid-toned picture hardly looks different. Whatever
it misses shows the same way it did before, for one frame.

On a still picture, what the guard shows is identical to the video: the mean difference
measured 0.00.

### When the camera will not open

`openCamera()` retries every `cameraRetryAt` (15s) until it succeeds, then clears the error and
re-arms the shutter. A camera can be unavailable for reasons that have nothing to do with this
page and that clear up on their own — another app holding it, or the device's own camera service
wedged until something releases it. Without the retry, a fault at 9am is a dead exhibit until
somebody notices, even if the camera freed itself a minute later. It deliberately sits outside
the generation counter `reset()` bumps: recovery has to outlive a visitor's turn.

**It borrows a picture and carries on.** A camera that will not open used to end the piece: the
message went up, the shutter stayed dead, and nobody could see what the exhibit was *for*. It
now takes a random picture from `img/sky/` — the same set the gallery wall shows — puts it in
the viewfinder, and runs the whole interaction on that. A visitor sees one line in place of the
framing instruction: *"Camera is undergoing maintenance. Try sharing your sky with this example
astrophotograph!"* The second sentence waits until the borrowed picture has actually loaded,
because the piece is about what a photograph is and a visitor should not be left thinking that
one is theirs. A different picture is borrowed
for each visitor, so a camera broken all day does not become the same photograph forty times.

The borrowed picture sits *outside* the crop wrapper and takes none of the rotation: both of
those correct for how a camera is bolted to a bracket, and this picture was never on one. The
frame takes the borrowed picture's own shape instead of the camera's.

Two small things had to give way for it, both of which had quietly assumed a camera: the
countdown returned immediately unless `feed.videoWidth` was non-zero, and every retry called
`showCameraFault`, which disables the shutter — so on a camera-less machine the shutter looked
alive and did nothing, then died again fifteen seconds later.

**Everything else about the fault shows only while the debug menu is open.** That covers the
cause in plain words ("Another app may be using it"), the stand-in notice, and a service note
with the fault name, origin, secure-context state, browser engine and retry count. With the menu
closed, everything on screen is public-facing. `toggleDebug` puts `debug-open` on the root
element, and `.err-debug` is shown only under it. Whoever is fixing a kiosk that will not start
has no debugger and usually no second machine, so opening the menu and photographing the screen
has to be enough to work from.

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
| `edit` | Their photo built up a colour at a time, the three channels it is made of beside it, the paragraphs that explain both, and then **the question** | `Next`, once the question has been answered |
| `adjust` | The picture alone and large with two sentences; then, on `Next`, the same charts back with a spectrum across each, and **the question again** | `Next`, then `Share my sky` once the second question has been answered |
| `confirm` | The picture across the screen, the question large underneath it | `No` / `Yes` |
| `reality` | What everybody has answered: the camera's picture against the edited one | `Start again` |

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

### How wide a line of it is

Every paragraph is set for **about ten words to a line**, and the measures are in `ch` so they
hold at any type size. Measured on the kiosk: the two paragraphs beside the layers run 10 and 13
words, the share question is one line of 10, and the last screen's lead runs 7 to 11.

They were all 24–26ch before, which on a 2160-wide screen is four or five words — that reads as
a poem, and a reader spends the whole paragraph starting again. The one block still short of ten
is the sentence beside the picture on step 3: at 50px it wants about 1875px and the column it
sits in is 1598, so it balances into four and six. Widening that one needs either a narrower type
size there or a column that spans the screen.

The caps live in four places — `.step[data-step="edit"] .story`, the shared
`.story-wide, .split[data-phase="ask"] .story`, `.story-ask`, and `.step[data-step="reality"]
.story-wide`. Two rules used to set a measure on the ask-phase story at the same specificity, so
the later one silently won and editing the other did nothing; there is one now.

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
### The share question, and the two ways out of it

The picture gets the whole width here — 88vw, centred, with the question underneath rather than
beside it. It was a two-column row, and at half the width the photograph read as an illustration
to the question instead of the subject of it. This is the last and longest look a visitor gets
at what they made, so it gets the room. Two limits decide the size and which one binds depends
on the shape of the photograph: a landscape picture stops at 88vw, and the 68vh cap is set just
high enough that a portrait one reaches the same 88vw on the kiosk's 9:16 screen without
crowding the question below it.

The answers are in the dock, which is below the question anyway, and they are held back until
the question has finished arriving — offering a choice before it has been put is a way of
getting the wrong answer.

Behind the question, two strips of the wall itself run past — the top one leftwards, the bottom
one rightwards. The question is easier to answer with the thing it is about already on screen,
and it makes the next beat legible: saying yes is visibly *joining* that.

They are the curated pictures, fetched from **`api/gallery/all`**, which is a new endpoint for
exactly this and deliberately claims nothing. Joining the register the way a real gallery screen
does would put the tablet on the wall as an extra screen, holding a hand of pictures the four
monitors could then not show. Nine pictures per strip, laid down twice: the loop runs the length
of one pass and jumps back, and with two identical passes that jump lands on the same pixels.

Four movements carry the picture through, and they are one continuous gesture rather than four
effects:

| | |
| --- | --- |
| leaving `adjust` | it stretches out of shape, anchored at the bottom right so the top left is the corner that travels, and **holds** there |
| arriving | the hold releases: it spins in from off the left edge, turning, into the middle |
| **Yes** | the strips stop, a space opens in one of them, and the picture turns down into it |
| **No** | it falls — slowly, swaying, like a feather, and then the piece restarts |

Yes, in full: both strips ease to a halt; a space opens from nothing at a randomly chosen print
that is currently on screen, in whichever strip; the picture turns a full revolution as it
shrinks into that space; and then the whole wall accelerates away to the right. With an empty
`img/sky/` there is no wall to join, and it falls back to the old exit — away to the right,
turning, off the edge.

Three details that are each a bug avoided:

- **The strips stop before the space opens.** Landing a picture in a moving target means
  re-measuring mid-flight; stopping first is both simpler and a better beat.
- **Spacing between prints is `margin`, not the flex `gap`.** With `gap`, inserting the empty
  element would shove its neighbours sideways by one gap's width before the animation had
  moved anything.
- **Reversing an infinite animation stalls it.** Played at a negative rate it walks its clock
  back past the start and stops there, so the leftward strip is not reversed — both strips get
  fresh rightward keyframes starting from exactly where they stand.

When the column is short, the strips are the only thing that shrinks: `.confirm-mid` is
`flex: none` so the photograph keeps its shape, measured at 0% distortion on the kiosk's screen
and on a 1080×1920 window alike.

The stretch runs on the screen being left, not the one arriving, which is why it reads as the
picture being carried across rather than one picture leaving and another appearing. Nothing
cancels that animation before the step changes: the cancel and the section swap happen in the
same task, so the snap back never paints.

The fall is deliberately not a drop. Gravity is the wrong feeling for something a visitor made
being let go of, so there is no acceleration, and the sway and the tilt run at different rhythms
so they never line up into something mechanical. It costs two and a half seconds, which is the
point.

### The filter wheel

While the first two sentences are being read, a filter lies across the right-hand quarter of the
photograph, and the visitor turns the wheel it belongs to. A filter passes a band of light and
stops the rest, and turning the wheel shows the picture through each one: **RGB**, then **Red**,
**Green**, **Blue**. RGB is the first stop and the sum of the three that follow it — the camera
the visitor has just used, taking all three at once, against three pieces of glass that each
take one.

**They used to be named for elements** — Hα, OIII and SII, written out as Hydrogen, Oxygen and
Sulfur — which reads as the glass sorting light by what it came off. That is not what a filter
does: which elements happen to glow in the band it passes is the astronomer's business, not the
glass's. The band in nanometres is kept underneath each name, where it is precise rather than
decorative.

**The size falls out of the shape.** A circle that bulges a quarter of the picture's width at the
middle of its travel and still reaches the top and bottom corners of that band has a radius of
`(band² + (height/2)²) / 2·band` — a little over **3200px** across on the kiosk, so most of it
runs off the screen and what is left is the arc. Measured: the band is **400px**, **25%** of the
picture, reaching **every row** of it, 8px at the corners and 400px at the middle.

The wheel lives **inside the picture**, which gives it its cropping for nothing: the photograph's
own top and bottom edges cut the flat edges the name and the wavelength are printed between. The
mount is a **ring** — a black band with a thin white line round its outer edge and nothing at all
painted in the middle, because a filled disc there would become the backdrop the glass samples,
and the glass would tint that instead of the photograph.

**Turning it.** Two chevrons in the band say it turns, and nudge along their own direction until
a finger takes them up. A drag anywhere on the screen turns the wheel with it — up, because at
nine o'clock that is the way the rim of a wheel turning clockwise actually travels — and the tint
changes under the finger as each filter passes the gate, which is the thing being said and this
is where it is said best. The gearing is a quarter of the picture's height per filter, not the
literal arc, because the rim of a wheel this size travels thousands of pixels between stops and
no finger can follow that.

Letting go settles it on the nearest filter, a flick carries it one further, and a tap asks for
the next. **Any deliberate push is worth one filter** even if it was a short one: rounding alone
would mean half a filter is a drag of well over two hundred pixels, and a visitor who pushes it
fifty and watches it settle back where it started has been told the thing does not work.

**The colour arrives with the glass, not after it.** The filter swinging in is lit before it
starts moving and the one leaving keeps its colour until it has gone, so there is never a frame
of clear glass across the picture — an earlier version waited for the swing to finish and
coloured the glass then, which put a second of nothing in the middle of the photograph and read
as the exhibit thinking about it.

Nobody swipes a photograph unprompted, so if the arrows are not taken up within four seconds the
wheel turns itself and keeps going, and the point is still made to a visitor who only watches.
The first touch ends that for good and the arrows fade.

**What the glass does.** A filter keeps the brightness and throws away everything but its own
band. Everything after `grayscale(1)` in the chain composes to a single linear map, so grey goes
in and one fixed colour times that grey comes out; the `brightness()` in front of it is
**solved**, not picked, to put the brightest pixel exactly at the top of its channel so nothing
clips anywhere on the ramp and the picture's own shading survives. Measured in the browser, a
mid grey of 204 comes out **(204, 0, 0)** through red, **(1, 204, 1)** through green and
**(0, 0, 204)** through blue — each on its own channel, tracking the picture one for one, with
nothing at all in the other two. RGB passes the picture through unchanged, which is the honest
first stop: it is the camera the visitor has just used.

Get that chain wrong in either direction and the glass either crushes to black or blows out.
Saturating a nearly-white pixel cannot colour it — there is no colour left to push — so an
over-saturated chain turns the bright parts of a picture yellow whatever line they were meant to
be. `scratchpad/solve.mjs` in the session that wrote this searched the hue-rotate and saturate
pair for each line; the numbers in `FILTERS` are its answer.

Four things worth knowing if it is ever touched:

- **Never write `-webkit-backdrop-filter` by hand.** esbuild knows it is the same property as
  `backdrop-filter` and keeps only the last of the two, so the prefixed spelling written after
  the standard one throws the standard one away — and Chrome 153 has dropped the prefixed alias
  altogether, which leaves the built rule parsing as nothing and the glass quietly not
  filtering. The build adds the prefix itself, in the order that survives.
- **Only the filter in the gate filters anything**, and the tint is dropped before a swing and
  restored when it lands, so nothing is sampling a backdrop sliding across it. Under a finger it
  stays live, which is the one place it earns the cost.
- **The turn animates a registered `@property` angle.** A custom property is a string until it
  is registered, and a string cannot be interpolated — without the registration the wheel jumps
  from stop to stop instead of turning. The easing overshoots and settles, because a wheel with
  detents does not glide to a halt.
- **The labels stay upright** rather than rotating with the wheel. A real one carries them round
  and half of them end up upside down; on a wall read from two metres away, legible beats
  faithful.

### The question, twice, and where the answers go

**It is asked twice, and the pair is the point.** Once on step 2, of the picture the camera made
on its own — the paragraph ends at *"an image that approximates what you see with your eyes"* and
the question is a block of its own underneath it. Then again on step 3, of the same picture once
the visitor has moved its colours somewhere the camera never put them. Both are set at twice the
paragraph's size (measured, 80px against 35px on the kiosk), separated by a rule and a good deal
of air, and both carry the three-colour **"real"** — the word written four times, once per
channel in `plus-lighter` on top of a parent that holds the line's width, so apart you see the
colours it is made of and together they come back to white.

**The way on does not exist until the question is answered.** `Next` on step 2 and `Share my sky`
on step 3 stay in `.waiting` — in the dock, holding their place, at zero opacity — until the
figure is moved, and then `pop()` them in. A question with a way past it sitting next to it is a
question a visitor is invited to skip; this one is the screen's whole business. (The `Next` that
brings up the spectra on step 3 is *not* gated, because that screen's question has not been asked
yet at that point.)

Under each is the answer: **a figure the visitor walks between No and Yes**, along a bar that
runs red through blue to green. It takes the colour of the bar under its feet — measured, the
pixels the browser paints match the computed colour, `rgb(38,191,120)` asked for and
`rgb(38,191,120)` drawn at the Yes end. No is on the left because the colours are red for no and
green for yes, and left-to-right agreement is the way every other scale a visitor has ever
filled in runs.

**It is two drawings, and it walks.** `img/animation/Frame1.png` is mid-stride and `Frame2.png`
is the passing pose. They are used as **masks over a block of the scale's colour**, not drawn as
images — which is what lets a photograph of a person be painted in the bar's colour the same way
the vector drawing before them was. Both are in the page from the moment the question is asked,
one hidden, so the first step never waits on a download.

Three things make two stills read as walking:

- **The step belongs to distance, not to a clock.** `js/main.js` accumulates how far the figure
  has travelled and changes feet every `STRIDE` (0.045 of the bar, about forty pixels against a
  figure ninety wide). A cycle on a timer would jog on the spot while the visitor holds still,
  and a figure that glides the whole bar without stepping is on wheels. The swap is a `while`,
  not an `if`: one drag event can cover several strides, and a walk that can only take one step
  per event stops stepping exactly when the hand moves fastest.
- **It faces the way it went, and stays facing that way.** The art faces right; left is the same
  drawing mirrored about its own centre and bottom edge, so it turns on the spot rather than
  sliding sideways. Snapping back to facing right when the finger lifts would read as a sprite
  rather than a person.
- **Height is what is held constant between the poses, not width.** The two are 2208 and 2161
  pixels tall and very different widths — being different widths *is* the walk. Both are scaled
  to the box's height and anchored to its bottom, so the figure stays one size and its feet stay
  on the bar. Centred horizontally rather than aligned on the head: measured, the heads land
  within 0.015 of the figure's height of each other that way, about two pixels at this size, and
  two pixels of sway is what walking looks like.

The whole block is the handle, not just the figure: a person standing on a bar is a small target
and the bar is the obvious thing to reach for. Arrow keys work too, which is the only way anyone
gets at it without a touchscreen. The scale itself is written once, in a `<template>` at the foot
of `index.html`, and cloned into each question — two copies of it in the page is two copies that
drift apart.

Each starts in the middle, undecided, and **is only reported if it was moved**. An untouched
scale is not somebody answering "undecided", it is somebody who walked away, and averaging the
two together would bury the difference in exactly the number this is being kept for.

**Where they go.** One row per visitor per question, written when that screen is left — pressing
on, or the exhibit giving up and starting again with nobody there. `server/answers.js` appends to
`data/answers.csv` on whichever machine serves the pages:

```
time,stage,value
2026-09-16T01:00:13.373Z,unedited,0.861
2026-09-16T01:00:25.931Z,edited,0.221
```

`value` is 0 at No and 1 at Yes; `stage` is which picture was being asked about. Rows of only two
fields are from before there were two questions to tell apart, and are read as `edited`, which is
the one that existed then. The folder is in `.gitignore`: it is data, and it belongs to the
machine that collected it.

On the **admin page** the two buttons for it sit together: **Answers (CSV)** downloads the file,
and **Clear _n_ answers** throws it away — it counts what is on file, so the operator can see
what they are about to lose, greys out at zero, and asks twice ("Press again — download it
first"), disarming on its own after four seconds so a half-pressed button cannot be finished by
somebody walking past. Clearing is the one thing here that cannot be undone: the pictures stay
on disk after they scroll off the wall, and these rows exist nowhere else. The same three things
are `GET api/answer`, `DELETE api/answer`, and `GET api/answer/summary` for step 4's charts. A visitor who is mid-answer when the kiosk reloads is still counted — the report goes
out as a beacon, which survives the page where a fetch would not.

One thing worth knowing if this is ever changed: the answers are kept in a module-level
`answered` object, written when each is reported, **not** read back off the scales. Every step
handler calls `clearBeats` on the way in, which puts both scales back to untouched, so by the
time step 4 asks them they no longer know.

### Asking the question

The adjust screen stops after two sentences — what the visitor did, and what an astrophotographer
does — and then waits, with a **`Next`** button. It used to wait on a timer instead, and a timer
is the wrong instrument: too short and it answers the question for them, because there is nothing
left to wonder about once there is something to fiddle with; too long and a still screen reads as
an exhibit that has stopped. Ten seconds was tried and was both.

`Next` brings up the spectra under a heading, **Try changing the colors**, which is the only
thing on that screen telling anybody what to do and is sized accordingly.

**The swatches knock rather than glow.** They had `0 0 18px var(--acc)` on them — a soft coloured
halo, on a near-black ground, which is precisely the ramp the exhibit panel cannot hold still and
precisely where "red and blue pixels everywhere" comes from. The invitation is now a hard 3px
ring that grows out of the swatch and goes: every frame of it is a flat colour with an edge, so
there is no soft gradient anywhere in it.

Change a colour and the question arrives underneath, larger than the text above it:

> Is this image **real**?

**"real" is written four times.** Once in the parent, transparent, to hold the line's width; then
once per channel on top of it, in red, green and blue, combined with `mix-blend-mode:
plus-lighter` — *added* rather than painted over each other. The three drift a fraction of the
word apart and back, so it separates into the colours it is made of and returns to white. It is
the same arithmetic, and the same point, as the three layers that built the picture two screens
earlier.

Two things that would break it, both avoided by construction:

- **Nothing may set opacity, transform or filter on `.real-word`.** Any of the three makes a
  stacking context, and a stacking context is exactly what stops `plus-lighter` reaching the page
  behind the word — the three would stack instead of adding, and the word would come out blue.
  The drift is animated on the copies, never on the parent, and the reveal's own opacity
  animation is cancelled the moment it lands. Measured with the three held together: the
  brightest pixel in the word is `rgb(255, 255, 255)`, channel spread **0**.
- The three copies carry `aria-hidden`, or the line is read out as "realrealrealreal".

7. The question arrives only once a colour has been moved *off its own hue* — touching the strip
   and landing back where you started has not answered anything. `Share my sky` then waits on
   the question itself, and appears when the figure is moved. It no longer shares anything
   either: it asks.

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

**Step 4 — what the room answered:**

8. Opens blank, deliberately. The line types on an empty screen, holds, and then rides up as the
   charts arrive underneath it.
9. Two charts, one above the other: every answer to *Is this image real?* given about the
   camera's own picture, and every answer given about the same picture once its colours had been
   moved. Bars rise where more people said that, in the colour of the scale they said it on, and
   a white marker shows where this visitor stood on each.

The screen is not about the visitor's picture at all, which is the point of ending on it: they
have just been asked the same question twice and been shown that their two answers were
different, and this is the room answering it the same way.

*(Step 4 used to be the Pillars of Creation in step 2's arrangement, with the same three charts
over it. It was removed in favour of this; `git log -- img/pillars.jpg` finds the picture if
it is ever wanted back.)*

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
the visitor is: four numbered stations — `1. Photo`, `2. Adjust`, `3. Share`, `4. Reality` —
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

### Cropping the feed

Four sliders in the debug menu — **Crop top / right / bottom / left**, 0–40% each — trim the live
feed, and **Clear the crop** puts them all back. A camera bolted to a bracket sees things the
exhibit would rather not photograph: the edge of its own housing, a fire door, the top of
somebody's head at the next exhibit along.

It is remembered in `localStorage`, so the machine comes up tomorrow aimed the way it was left.
The perf overlay carries a `crop` line showing the four numbers.

**Trimming one edge closes in on the other axis to match.** The window has to keep the frame's
shape, so cropping 25% off the top also narrows the view by 25%, centred. That is what any
camera does when its output has a fixed shape, and it is the reason the photograph agrees with
the viewfinder rather than nearly agreeing with it. Trim, then trim the opposite edge to slide
the window back the other way.

Two things make it safe to change while the exhibit is running:

- **The crop lives on a wrapper**, not on the video. The quarter-turn rules size the video from
  `--frame-w` and position it at `left: 50%`, and folding a crop into each of those transforms
  is how that gets broken. The wrapper is exactly the frame's box, so everything those rules
  measure is unchanged, and `.live-frame`'s existing `overflow: hidden` does the cutting.
- **The capture applies the same window**, outside the turn and the mirror, so it is in the same
  coordinates the visitor was looking at. Checked against an uncropped capture of the same
  source at both rotations and four different crops: the cropped frame comes back **identical**
  to the matching sub-rectangle of the uncropped one, mean difference 0.00, worst pixel 0. With
  no crop set it is bit-for-bit what it was before there was one.

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
  end. (They used to tween out to it from the ends of the track as an introduction; that
  belonged to the Pillars screen, which is the only place it was ever called from, and went with
  it. The rock below is what invites a finger now.)
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
- **Each handle carries a ↔, and rocks until it is touched.** This is a touchscreen: there is
  no hover to hint with, and nothing else on screen says these two chips are the thing to grab.
  The arrow says it can be moved and which way; the rock — 9px in and back over 2.6s, with a
  long dead hold, the black one leading the white by 0.28s — says it moves at all. Turned on
  with the charts (`setPulsing()`), and each editor stops for good on its own first movement
  (the `touched` flag in `createLevels`), because a cue that keeps running after it has been
  understood stops being a cue and becomes noise. The arrow stays: it is a property of the
  object rather than a cue about it.
- **It is a movement, not a light.** The version before this put a 16px `box-shadow` glow behind
  each handle and expanded a feathered ring out of it. That is the exact soft ramp on near-black
  that the exhibit's 6-bit panel dithers, and the exact source of the red and blue speckle this
  piece spent a day chasing — see *Banding on the exhibit panel*. Measured across the 54px of
  card out from a handle: **0 pixels differ from their neighbour**. A glow ramps most of the way;
  this is flat.
- **The arrow is two chevrons and a shaft, not two bars.** A pair of upright bars is the grip
  idiom for a draggable thing, and in a round chip it is also the play/pause button on every
  other screen in the building — it was tried, and it reads as pause. It is drawn as a
  background image rather than a pseudo-element because both of those are taken (`::before` is
  the oversized touch target, and masking that to make a mark out of it would shrink the target
  back to the size of the mark), and there are two copies of the SVG because `stroke` in an SVG
  loaded as an image cannot see `currentColor` and one of the chips is white.
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

`js/imaging.js`. The capture is split into its real R, G and B planes once.
Everything after that is a per-channel levels curve applied as a 256-entry lookup table:

```
out = clamp((in - black) / (white - black)) * 255
```

The planes are written once and only ever read, so the underlying measurement survives no matter
how far the levels are pushed — `reveal` can always go back to the camera's original because it
is still there.

### How much picture survives, and where it is lost

Four numbers decide the quality of everything on screen, and all four were once set low enough
that a better camera bought nothing at all.

| | | |
| --- | --- | --- |
| what the camera is asked for | `1280x720` → **`3840x2160`** | `ideal`, so a 720p camera still returns 720p — it never fails, it only settles |
| `CAPTURE_EDGE` | 1400 wide → **2600 longest edge** | what is kept of the stream; the source for everything below |
| `VIEW_EDGE` | 1000 wide → **1600 longest edge** | what every slider redraw works on, so the one number with a per-frame cost |
| `WALL_EDGE` | 2600 → **1200 longest edge** | what a shared picture is kept at, on the wall and in the archive |
| `PILLARS_EDGE` | 900 → 1400 → **removed** | went with the Pillars screen when step 4 became Reality |

**The camera request was the whole of the "every camera looks the same" problem.** `ideal` is a
preference the browser satisfies as closely as it can, and every camera worth buying does 720p
exactly — so every camera did.

**Sizing is on the longest edge, not the width.** With a width cap the bracket decided how much
of the sensor survived: a camera mounted sideways delivers a portrait frame, whose width is its
*short* edge, so the same 4K camera kept twice as many pixels turned on its side as it did
upright. Landscape and portrait now both come to 3.80 MP, measured.

**`downscaleFrame` averages.** It used to take whichever source pixel landed under a rounded
coordinate — nearest neighbour, throwing away three pixels in four on a 2× reduction. That does
not soften detail, it aliases it, which on a face reads as noise around the eyes and hair. A
one-pixel checkerboard halved now comes out a flat 128 across the whole frame; before it came
out as a field of 20s and 235s.

**The JPEG is 0.95**, up from 0.88. 0.88 is where ringing starts to show on hard edges, and a
crushed channel makes plenty of them. 1.0 nearly triples the file for no visible gain and the
wall loads dozens at once.

None of it is free, but the cost lands where there is room for it. For a rotated 4K capture
(1463x2600, 3.8 MP), measured:

```
editing copy      45 ms  ┐ at the shutter, inside the 420 ms freeze the flash already holds for
thumbnail         21 ms  │
resting levels     0 ms  ┘
shared jpeg       87 ms    once, when a visitor presses Yes — 1.05 MB (before WALL_EDGE)
```

**The shared picture is 1200 pixels on its longest edge**, not the full 2600. The wall screens
are Raspberry Pis, and the wall never draws a print more than about 900 pixels across on a
1080p screen: it's fitted into 46% of the screen's width. At full size, every visitor's picture cost each Pi about 15 MB of decoded image for
detail nobody sees from across a room. It's shrunk with `downscaleFrame` before the JPEG is
made, the same box average every other smaller copy uses. A test capture at 3840x2160 was
shared at 675x1200 (upright), 39 KB. The archive keeps this size too: the full capture is not
stored anywhere.

The same reasoning applies to the curated set in `img/sky/`. Those files are served exactly as
they are, so shrink them before adding them: **1200 pixels on the longest edge**, or 1600 if a
Pi drives a 4K signal, sRGB, JPEG quality around 85:

```bash
magick mogrify -path resized -auto-orient -colorspace sRGB -resize "1200x1200>" -quality 85 -strip originals/*.jpg
```

The sliders are unaffected by any of it: every interactive redraw works on `viewFrame`, never on
the full capture.

The performance overlay (<kbd>P</kbd>, or the long press) now carries a **`capture`** line
reading `camera 3840x2160 -> kept 1463x2600 (3.8 MP)`. That is the quickest way to tell whether
a camera is really being used or is quietly handing back 720p — which is exactly the symptom
this was.

## Where to change things

- `js/main.js` — **every word the visitor reads**, in `STORY`, `STORY_AFTER`, `SHARE_STORY`,
  `REALITY_LEAD`, near the top of the step-2 section. A segment marked
  `block: true` starts its own line after a pause. They are typed rather
  than rendered, so they live in the script and not in the markup.
- `index.html` — the structure of each step, and the credit line.
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
| `?fx=off` | as above, and no glow on the channel names |
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
| the **×** in its corner, <kbd>Esc</kbd>, or the same chord | closes it |

A modifier rather than a bare key, because unlike the readout these buttons *do* things. It
holds **Rotate camera**, the four **Crop** sliders, the four **Pad** sliders, **Camera
resolution**, **Frame guard**, **Denoise**, **Ground**, **Background glow**, **Perf overlay** and **Restart**,
each showing its current state beside the label.

**The × exists because the rest of that row is a keyboard.** Every other way out of this menu
wants keys, on a machine whose entire premise is that it has no keyboard — so on the kiosk the
only way to close it was to knock it open again. It is 40px, which is the smallest thing a
finger reliably hits, and the menu scrolls now as well, because it grows a row every time
something is added to it and the screen it opens on is not always the tall one.

**Pad** takes room off the edges of the whole page — the bar, the screen and the button
together — to fit the piece inside whatever it has been built into. Four separate edges rather
than one inset, because a housing's aperture is as often off-centre as it is small: two of them
shift the picture and the other two shrink it. Horizontal in `vw` and vertical in `vh`, so a
panel swapped for a different one keeps the same fit, and remembered like the crop, because the
aperture is a fact about one installation that nothing in the design can know. Measured at
6vh/4vw/3vh/2vw on a 2160×3840 screen: `230.4px 86.4px 115.2px 43.2px`, the bar and the screen
both 2030 wide instead of 2160, and the dock's foot at 3725 instead of 3840.

It lands on `body`, which is the grid that holds all three rows, and `box-sizing: border-box`
with `height: 100dvh` is what makes that take room away from the rows rather than pushing the
dock off the bottom of the screen. The menu itself is `position: fixed` and so is unaffected by
it — which it has to be, or the control would walk away from the finger adjusting it.

The tap sequence uses the progress bar's own station marks. They have no behaviour of their own,
so a tap on one is already a no-op — which is what makes them safe to overload without taking a
press away from anything a visitor might want. It has to be a run: any other station, or a pause
over two and a half seconds, puts the count back to nothing, so idle prodding cannot leave the
exhibit armed for whoever touches it next.

The two overlays are deliberately separate objects. The readout must never be able to eat a
visitor's touch, so it stays `pointer-events: none` forever; the menu is interactive, which is
safe because nobody opens it by accident — the only way in from the screen is the tap run
above, on marks that do nothing else. Nothing is built until
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

### It came back, twice

The rule above is easy to state and easy to break, because every soft, low-alpha surface breaks
it by accident. Two later rounds of this, each found by screenshotting all four screens and
counting the dark pixels that sit more than three quarters of a level from anything a 6-bit
panel can display:

| | was | now |
| --- | --- | --- |
| `--panel`, the raised surface | `rgba(255,255,255,.045)` → (15,15,19), **1.19 off** | `.048` → (16,16,20), 0.19 off |
| `--well`, behind the histogram | `rgba(0,0,0,.35)` over it → (10,10,13), **1.90 off** | `#0c0c10` → (12,12,16), 0.14 off |
| the histogram's clipped region | 5% white over that → (23,23,26), **1.71 off** | falls out at (24,24,28), 0.29 off |
| the reels' edge fade | a mask to transparent over 6% of the width | gone |

Those two surfaces alone covered **40% of the charts column**. The adjust screen went from
20.9% of its dark pixels needing dithering to **0.5%**.

**The lesson is in `--well`.** It is given as a hex value rather than as an alpha over what is
behind it, because where an alpha composite lands is an accident of arithmetic — and near black,
an accident of one and a half levels is a screen that will not sit still. Surfaces in this range
get stated outright. An alpha is fine once it has been checked; `--panel` keeps one, at the
distinctly unround `.048`, and the comment there says why.

### The sky glow is off by default

It was on, and that is why this came back a second time: a browser profile that gets reset — a
kiosk reinstall, cleared storage, a different browser — forgets that somebody turned it off.
A default is the only setting that survives that.

Measured across all four screens at 2160x3840, share of dark pixels needing dithering:

| | glow on | glow off |
| --- | --- | --- |
| camera | 57.1% | 1.4% |
| edit | 39.5% | 1.4% |
| adjust | 43.8% | 0.5% |
| confirm | 43.6% | 6.2% |

`?glow=on`, or **Background glow** in the debug menu, brings it back and remembers it — worth
doing on any screen that can hold it still, because it is a nice thing on a monitor that can.

**What is left is not fixable and not a bug.** The 6.2% on the share question is dark regions of
the curated photographs themselves, spread across twenty thousand distinct colours. Any
photograph with shadows in it does that on a 6-bit panel, on any website. The bare background
beside the picture measures *nothing* needing dithering.
**The gallery's print shadows** stay. There a shadow falls on other prints as often as on the
wall, which is real work rather than a black blur on a black ground. Worth re-checking on the
wall panels, since the same defect would look the same.

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

`gallery.html`, the **anchored pile**: large prints, landing over one another on six places,
three down the left half of the screen and three down the right. (It replaced a *stacking grid*,
grids of ten laid over one another, which in turn replaced a *rows* design. `git log --
js/gallery.js` has both.)

Joining the wall and holding pictures nobody else has is `js/wallscreen.js`, apart from the
layout, because that half is the server's protocol and not a design choice. It has to change in
step with `server/gallery.js`, and fails only with four screens running if it does not.

### The anchored pile

Every picture arrives turning, onto one of the six places, and lands over whatever is already
there. The rules:

- **Sides alternate,** so the two newest pictures are always one on the left and one on the
  right.
- **A side never uses the same place twice running.** Each side draws its three places from a
  shuffled bag, and all three come up before any comes up again. A refilled bag is also kept
  from starting with the place the last one ended on, which a plain shuffle would do one time in
  three. So each picture overlaps the ones under it instead of exactly hiding the last one, and
  that overlap is the pile.
- **Each print is fitted, at its own shape, into a box 46% of the screen wide and 66% high,**
  centred on its place. It gets a nudge of up to 3% of the screen and a tilt of up to 3°, so the
  pile doesn't look ruled, and it's kept on screen even when a tall one sits at a top or bottom
  place.
- **Six prints are kept.** When a new one lands, the oldest is taken off, and a curated picture
  goes back to the server for another screen to use.
- **Every print lands on top of everything before it,** a visitor's included. A visitor's new
  picture goes up the moment it is shared, wears an orange outline until the next visitor's
  arrives, and turns a full revolution coming in, where an ordinary print turns about fifteen
  degrees. It used to be held on top for five minutes, but that made every picture laid in that
  time slide in *under* it. And after a reload, an old visitor's picture was the one held there,
  so for five minutes an hour the whole wall landed underneath somebody's photo from the day
  before.

Each print carries `data-place` (for example `left 2`), which the inspector shows, for checking
where things landed.

```js
anchors: { left: [3 places], right: [3 places] },  // centres, as fractions of the screen
size: { w: 0.46, h: 0.66 },  // the box a print is fitted into
jitter: 0.03,                // how far off its place a print may land
tilt: 3,                     // degrees, either way
keep: 6,                     // prints on the wall
addEvery: 30000,             // a picture is laid down this often
communityShare: 0.25,        // the visitors' share of what is on the wall
border: 9,                   // the black mount around every print
```

Checked on a 1920×1080 page with the clock run forward: 6 prints at every check, none off
screen, and every newly laid print above every other, a visitor's arrival included. Over
10,000 draws per side, no place came up twice running, every run of three used all three places,
and each place got 33.3%.

### Light enough for a Raspberry Pi 3

The wall screens are Pi 3B+s with 1 GB of memory, shared between the system, the browser and
the graphics chip. On a page like this, nearly all of that goes on pictures: the browser holds
every picture on the wall fully decoded, at the size of the file rather than the size it's
drawn, whether or not anything is covering it. So the wall holds as few as it can while still
looking like a pile:

- **Six prints.** The stacking grid held forty, then twenty. These are drawn much larger, but
  the memory depends on the files, not on the size they're drawn.
- **No blurred drop shadows.** A print has its black mount and a 1px hairline. The 34px blurred
  shadow it used to have had to be redrawn under every print that spun in over it, and needed a
  band of extra graphics memory round every print.
- **Its own stylesheet.** `gallery.html` used to load the exhibit's 22 KB stylesheet for three
  colours and a background. `css/gallery.css` now carries those itself, and the full-screen
  gradient background is gone: one less screen-sized surface.
- **Nothing reloads the page.** It used to reload itself every hour, and whenever the server
  forgot the screen. But a reload rebuilds everything from nothing, every picture fetched and
  decoded again, on a machine already short of power, and a reload that can't reach the server
  is a browser error page that never retries. Now, if the server forgets a screen,
  `wallscreen.js` signs it back in on its next claim, and what's on screen stays up and rolls
  over as usual. To start a screen afresh, reload it by hand or reboot the Pi.
- **Pictures at the size they're shown.** A print here is drawn up to about 900 pixels wide on a
  1080p screen, so 1200 on the long edge is right for both the visitors' pictures (`WALL_EDGE`)
  and the curated set.

**Test the gallery on the production build, not the dev server,** when the clock is being run
forward. The dev server's live-reload client reloads the page when it thinks the server has
gone, which fast-forwarded time makes it think.

**Undervoltage on the Pis is the power supply, not the page.** A Pi 3B+ wants 5.1 V at 2.5 A.
A TV's USB port, a phone charger or a long thin cable will all sag under load, and a Pi running
Chromium will report undervoltage even on a page doing nothing. Check with
`vcgencmd get_throttled`: `0x0` is healthy, and a non-zero value with bit 0 or bit 16 set
means undervoltage now or since boot. The fix is the official supply, or one equal to it, on a
short cable.

### Keeping the visitors' share

Every submission goes up the moment it is made. That is the promise the exhibit makes to the
person who just pressed the button, and it isn't negotiable against a ratio. The share is
counted over what is on the wall now, since prints are taken off and the counts with them, and
it's pulled back by the timer: while the visitors' share is over a quarter, the next picture is
a curated one.

The stacking grid used to rebalance straight away, laying several curated pictures down right
after a visitor's. On a wall of six that would bury the very picture it was for, so it's gone:
the pile rolls over at one picture every half minute, and a rush settles within a few minutes.

### This design eats pictures

The wall lays down a new picture every half minute. Four screens running for an hour lay down
about 480, so the curated folder wants to be large for the wall not to repeat visibly: **sixty
or more**. See below.

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

Add pictures by dropping them into `img/sky/`. On the exhibit machine, the gitignored
`img/sky-old-test/` holds an older set of NASA pictures that can be moved in to pad it out.

**Attribution is not handled.** The wall shows no captions by design. The pictures now in
`img/sky/` are numbered (`01-GalleryPhotos2026.jpg` …) and carry no photographers' names, unlike
the set before them. If the exhibit needs to credit anyone on screen, the names have to come from
somewhere else first.

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

On the exhibit camera (Arducam B0589, `04b4:0822`):

- **4K in the browser.** The browser still needs confirming. At the kernel level it works:
  `v4l2-ctl` streams 3840x2160 MJPG at 30fps cleanly. Set **Camera resolution → 4k** and check
  that the overlay reads `3840x2160 @30fps`. If it still steps down, the next thing to try is
  `frameRate: { exact: 30 }` in `js/camera.js`.
- **HDR.** Needs the output of `v4l2-ctl -d /dev/video0 --list-ctrls-menus` to find which
  control switches it on, and then a udev rule to set that control on every plug-in.
- **Dropouts.** Not explained yet. The link is USB3 (5000M) and the stream is MJPG, so neither
  bandwidth nor format is the cause. Run `sudo fuser -v /dev/video*` with the exhibit closed to
  look for a second program holding the device.
- **Exposure, gain, brightness and contrast in the debug menu.** Not built yet. It needs the
  output of `getVideoTracks()[0].getCapabilities()` from the kiosk.

## Lineage

Fifth prototype in `AstroProto/`, forked from `IsItReal`. The levels/histogram reasoning goes back
to `FiltersGreyscale/web/index.html` (black point, contrast and brightness as a shared tone LUT),
the multi-display arrangement to `FiltersNew/`, and the mirrored-capture and
camera-selection lessons to `Filters/`.
