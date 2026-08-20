import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Browser development uses the same-origin `/api` proxy so the HttpOnly
  // session cookie belongs to Vite's host. Keeping the proxy target separate
  // prevents `localhost` and `127.0.0.1` from creating incompatible cookies.
  const apiTarget = env.VITE_DEV_API_TARGET || env.VITE_API_URL || 'http://127.0.0.1:8787';

  return {
    server: {
      host: '127.0.0.1',
      port: 5175,
      strictPort: true,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          ws: true
        }
      }
    }
  };
});
