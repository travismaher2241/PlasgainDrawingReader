import {defineConfig} from 'vite';

// In development the API runs separately (npm run server) and Vite forwards /api to it.
export default defineConfig({
  server: {proxy: {'/api': 'http://127.0.0.1:' + (process.env.PORT || 8787)}},
});
