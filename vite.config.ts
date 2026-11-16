import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createApiHandler } from './server/api.mjs';

function localReadApi(): Plugin {
  return {
    name: 'openchami-local-read-api',
    configureServer(server) {
      server.middlewares.use(createApiHandler());
    },
  };
}

export default defineConfig({
  plugins: [react(), localReadApi()],
  server: { host: '127.0.0.1' },
});