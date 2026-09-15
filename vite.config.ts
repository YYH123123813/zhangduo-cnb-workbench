import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { clientBoundary } from './tools/client-boundary';

export default defineConfig({
  envDir: process.env.ZHANGDUO_LOCAL_DEMO === 'true' ? false : undefined,
  plugins: [clientBoundary(), react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT || 4310),
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.API_PORT || 4311}` },
    watch: {
      followSymlinks: false,
      ignored: ['**/.local/**', '**/training/.venv/**', '**/training/vendor/**'],
    },
    fs: { strict: true, deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local/**', '**/*.sqlite*', '**/src/platform/**', '**/src/server/**'] },
  },
});
