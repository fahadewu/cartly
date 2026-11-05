import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv } from 'vite'

// The admin panel runs beside the storefront (5173) and proxies API calls to the NestJS API,
// on API_PORT from ../backend/.env so the port lives in one place. 127.0.0.1, not localhost: on macOS
// another process can hold the same port on IPv6 and `localhost` would reach it instead.
export default defineConfig(({ mode }) => {
  const { API_PORT = '4100' } = loadEnv(mode, fileURLToPath(new URL('../backend', import.meta.url)), 'API_PORT')
  const proxy = { '/api': `http://127.0.0.1:${API_PORT}` }
  return {
    plugins: [vue()],
    server: { port: 5174, strictPort: true, proxy },
    preview: { port: 4174, strictPort: true, proxy },
  }
})
