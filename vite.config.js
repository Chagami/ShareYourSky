import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { wallStore } from './server/wall.js'
import { galleryAllocator } from './server/gallery.js'
import { answerLog } from './server/answers.js'

// Where the exhibit answers, and how. The defaults are the developer's; the exhibit machine
// sets these in scripts/exhibit.env, so the address on the kiosk shortcut can be a bare name
// with no port after it.
//
// Three modes, in order of precedence:
//
//   SKY_CERT + SKY_KEY   real https. The certificate has to be issued for the *name* clients
//                        type — one for an IP address will not do, which is half the reason
//                        for having a name at all.
//   SKY_HTTP=1           plain http, no TLS. What http://sharedsky needs.
//   neither              self-signed https, the useful default on a dev machine because the
//                        camera works over it from another device on the LAN.
//
// The catch with SKY_HTTP, and it is the whole catch: getUserMedia exists only in a secure
// context, and plain http is not one unless the host is literally localhost. The gallery and
// admin pages have no camera and do not care. The interaction does — README, under "A name".
const PORT = Number(process.env.SKY_PORT) || 4173
const CERT = process.env.SKY_CERT
const KEY = process.env.SKY_KEY
const plainHttp = process.env.SKY_HTTP === '1'
const realCert = Boolean(CERT && KEY && existsSync(CERT) && existsSync(KEY))

if ((CERT || KEY) && !realCert) {
  console.warn(`\n  SKY_CERT/SKY_KEY are set but one of them is missing on disk.`)
  console.warn(`  Falling back to ${plainHttp ? 'plain http' : 'the self-signed certificate'}.\n`)
}
if (realCert && plainHttp) {
  console.warn(`\n  SKY_HTTP=1 and a certificate are both set. Using the certificate.\n`)
}

const https = realCert ? { cert: readFileSync(CERT), key: readFileSync(KEY) } : undefined

// basicSsl manufactures a self-signed certificate. Not wanted when there is a real one, and
// not wanted when the entire point is to answer on http.
const selfSigned = !realCert && !plainHttp

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
  // answerLog writes down what each visitor answered to "Is this image real?".
  // wallStore keeps the visitors' pictures; galleryAllocator hands the curated ones out to the
  // four gallery screens so that no two of them show the same thing.
  // basicSsl only when there is no real certificate to use — the two fight over the same job.
  plugins: [...(selfSigned ? [basicSsl()] : []), wallStore(), galleryAllocator(), answerLog()],
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
    port: Number(process.env.SKY_DEV_PORT) || 5173,
    // Reachable from other devices on the LAN. Vite prints the address on start.
    host: true,
    https,
  },
  // `vite preview` has its own server config; it does not inherit `server`.
  preview: {
    port: PORT,
    host: true,
    https,
    // The name the exhibit is reached by has to be allowed explicitly, or Vite answers requests
    // for it with a blocked-host error and every screen shows a wall of text instead.
    allowedHosts: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        gallery: 'gallery.html',
        // Linked from neither of the others. It is the page for whoever runs the exhibit.
        admin: 'admin.html',
      },
    },
  },
})
