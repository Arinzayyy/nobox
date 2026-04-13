import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      '/api': {
        target: 'http://localhost:3175',
        changeOrigin: true
      },
      '/callback': {
        target: 'http://localhost:3175',
        changeOrigin: true,
        rewrite: (path) => '/api/callback' + path.replace('/callback', '')
      }
    }
  }
})
