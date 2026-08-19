import { defineConfig } from 'vite'

// Two pages, no framework: the interaction screen and the gallery wall. Both need to be
// listed as build inputs or `vite build` would emit index.html only.
export default defineConfig({
  // Relative asset URLs, so a built copy runs from any folder — including straight off a
  // USB stick or a subdirectory on the exhibit PC — without rewriting paths.
  base: './',
  server: {
    port: 5173,
    // Reachable from other devices on the LAN if you ever want the wall on a tablet. Note
    // the camera needs a secure context, so the interaction screen itself still has to run
    // on localhost (or behind HTTPS).
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
