import { defineConfig } from 'vite';
import { networkTestPlugin } from '../scripts/network-shaper.mjs';

export default defineConfig({
  plugins: [networkTestPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // Preserve Host and Origin: the backend's same-origin check stays active.
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/socket.io': { target: 'http://127.0.0.1:3000', changeOrigin: false, ws: false }
    }
  }
});
