/// <reference types="vitest/config" />
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    // Server-backed mode talks to the backend through the dev server, so the session cookie is
    // same-origin and needs no CORS. Mock mode never calls /api.
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8080',
        changeOrigin: false,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Many tests drive real keyboard input through multi-step forms; allow for slow CI machines.
    testTimeout: 15_000,
  },
})
