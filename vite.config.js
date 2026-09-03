import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { wallStore } from './server/wall.js'
import { galleryAllocator } from './server/gallery.js'

// Two pages, no framework: the interaction screen and the gallery wall. Both need to be
// listed as build inputs or `vite build` would emit index.html only.
export default defineConfig({
  // Stamped into the bundle so the debug overlay can say which build is on screen. A kiosk
  // that has cached an old index.html looks identical to one that has not, and this is the
  // only way to tell them apart without a cable.
  define: {
    __BUILD__: JSON.stringify(
      new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
    ),
  },
  // Relative asset URLs, so a built copy runs from any folder — including straight off a
  // USB stick or a subdirectory on the exhibit PC — without rewriting paths.
  base: './',
  // Self-signed HTTPS. The camera needs a secure context, and only `localhost` gets that
  // for free — open the LAN address over plain http and `navigator.mediaDevices` is simply
  // undefined. Serving TLS makes every address a secure context, so the interaction screen
  // runs on a second machine.
  //
  // The cert is self-signed, so each new client hits one "Your connection is not private"
  // interstitial: Advanced -> Proceed. Once through, the camera works. To lose the warning
  // entirely, swap this plugin for `server.https` pointing at an mkcert-issued pair and
  // install the mkcert root CA on the client.
  // The gallery wall's store. The exhibit is two devices — the interaction on a tablet over
  // the LAN, the wall on a screen elsewhere — so the pictures have to live on the machine
  // serving the pages rather than in either browser. Kept as a middleware rather than a second
  // process so the exhibit is still one command to start.
  // wallStore keeps the visitors' pictures; galleryAllocator hands the curated ones out to the
  // four gallery screens so that no two of them show the same thing.
  plugins: [basicSsl(), wallStore(), galleryAllocator()],
  // Nothing to pre-bundle: this project has no runtime dependencies and every import in js/ is
  // relative, so the dependency optimizer scans the whole tree and renames a directory into
  // place to produce an empty result. On Windows that rename fails outright if anything is
  // holding the folder — Defender, the search indexer, or the server being restarted, which
  // now happens on every edit to server/wall.js because a config import is a config dependency:
  //
  //   EPERM: operation not permitted, rename 'node_modules/.vite/deps_temp_x' -> '.../deps'
  //
  // Turning it off removes the failure and the work at once. Add a real dependency and this
  // has to come back out.
  optimizeDeps: {
    noDiscovery: true,
    include: [],
  },
  server: {
    port: 5173,
    // Reachable from other devices on the LAN. Vite prints the address on start.
    host: true,
  },
  // `vite preview` has its own server config; it does not inherit `server`.
  preview: {
    port: 4173,
    host: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        gallery: 'gallery.html',
        // The rows design, kept alongside the stacking one so the two can be compared on a
        // real wall rather than in the abstract.
        gallery2: 'gallery2.html',
        // Linked from neither of the others. It is the page for whoever runs the exhibit.
        admin: 'admin.html',
      },
    },
  },
})
