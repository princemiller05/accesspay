import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Builds:
//   npm run build      -> demo shop + dashboard in dist/ (served by the Node server)
//   npm run build:lib  -> reusable component library in dist-lib/
//
// In development, Vite serves the pages on :5173 and forwards API calls to the
// Node server on :3000, so the browser sees one origin (same as production).
const API = 'http://localhost:3000';

export default defineConfig(({ mode }) => {
  if (mode === 'lib') {
    return {
      build: {
        outDir: 'dist-lib',
        lib: { entry: 'src/index.ts', name: 'AccessPay', formats: ['es'], fileName: 'accesspay' },
      },
    };
  }
  return {
    root: 'demo',
    build: {
      outDir: '../dist',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          main: here('./demo/index.html'),
          dashboard: here('./demo/dashboard/index.html'),
          pay: here('./demo/pay/index.html'),
          docs: here('./demo/docs/index.html'),
        },
      },
    },
    server: {
      port: 5173,
      proxy: { '/v1': API, '/shop': API, '/dashboard/api': API, '/checkout/api': API, '/l/': API },
    },
  };
});
