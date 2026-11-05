import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // The commerce API (cartly_backend), on API_PORT from ../backend/.env so the port lives in one place.
  // Same origin in dev, so no CORS or cookies to configure. 127.0.0.1, not localhost: on macOS another
  // process can hold the same port on IPv6 and `localhost` would reach it instead.
  const { API_PORT = '4100' } = loadEnv(mode, fileURLToPath(new URL('../backend', import.meta.url)), 'API_PORT')
  const proxy = { '/api': `http://127.0.0.1:${API_PORT}` }
  return {
    plugins: [vue()],
    // strictPort: a second `npm run dev` fails instead of taking the admin panel's port (5174).
    server: { port: 5173, strictPort: true, proxy },
    preview: { port: 4173, strictPort: true, proxy },
  }
})
