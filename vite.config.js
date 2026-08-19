import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

// Two pages, no framework: the interaction screen and the gallery wall. Both need to be
// listed as build inputs or `vite build` would emit index.html only.
export default defineConfig({
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
  plugins: [basicSsl()],
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
      },
    },
  },
})
