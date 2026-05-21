import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/frontend-react/',
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        mobile: path.resolve(__dirname, 'mobile.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3001,
    host: '0.0.0.0',
    proxy: {
      '/auth': 'http://localhost:8000',
      '/users': 'http://localhost:8000',
      '/products': 'http://localhost:8000',
      '/sessions': 'http://localhost:8000',
      '/reports': 'http://localhost:8000',
      '/attendance': 'http://localhost:8000',
      '/settings': 'http://localhost:8000',
      '/inventory': 'http://localhost:8000',
      '/purchases': 'http://localhost:8000',
      '/returns': 'http://localhost:8000',
      '/suppliers': 'http://localhost:8000',
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
    },
  },
})
