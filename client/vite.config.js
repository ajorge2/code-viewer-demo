import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// API requests are proxied to the Express server during development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:8799',
    },
  },
})
