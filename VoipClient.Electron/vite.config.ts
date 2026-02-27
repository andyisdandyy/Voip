import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Electron loads via file:// — crossorigin attributes block resource loading
function removeCrossorigin(): Plugin {
  return {
    name: 'remove-crossorigin',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/ crossorigin/g, '');
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), removeCrossorigin()],
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  build: {
    modulePreload: { polyfill: false },
  },
});
