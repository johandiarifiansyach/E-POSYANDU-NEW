import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_URL || 'http://localhost:3002';

  return {
    publicDir: '../public',
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
