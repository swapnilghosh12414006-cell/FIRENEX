import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const certificatePath = env.VITE_HTTPS_CERT;
  const privateKeyPath = env.VITE_HTTPS_KEY;

  if (Boolean(certificatePath) !== Boolean(privateKeyPath)) {
    throw new Error('Set both VITE_HTTPS_CERT and VITE_HTTPS_KEY to enable HTTPS.');
  }

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      https: certificatePath && privateKeyPath
        ? {
          cert: readFileSync(certificatePath),
          key: readFileSync(privateKeyPath),
        }
        : undefined,
      proxy: {
        '/api': {
          target: env.VITE_API_URL || 'http://127.0.0.1:8000',
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
