import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  root: path.join(__dirname, 'src/ui'),
  build: {
    outDir: path.join(__dirname, 'dist-ui'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4000',
    },
  },
})
