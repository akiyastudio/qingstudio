import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const packageVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(packageVersion),
  },
  base: './',
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    watch: {
      // The repository also contains generated media runtimes and build caches.
      // Watching them can create hundreds of thousands of Windows file handles
      // even though none of them are renderer inputs.
      ignored: [
        '**/.cache/**',
        '**/.tmp/**',
        '**/.venv/**',
        '**/.venv-release/**',
        '**/extensions/**/dist/**',
        '**/extensions/**/models/**',
        '**/extensions/**/vendor/**',
        '**/__pycache__/**',
        '**/artifacts/**',
        '**/components/**',
        '**/media-runtime/**',
      ],
    },
  },
  build: {
    outDir: 'artifacts/web',
    emptyOutDir: true,
    rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), toastView: resolve(import.meta.dirname, 'toast-view.html') } },
  },
})
