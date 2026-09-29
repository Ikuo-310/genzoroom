import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: { input: ['index.html', 'dev-webgpu.html'] },
  },
  server: {
    proxy: {
      '/api/': {
        target: 'http://127.0.0.1:8000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
