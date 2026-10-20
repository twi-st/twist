import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { fileURLToPath, URL } from 'node:url';

const noisy = (warning: { message?: string }) => {
  const message = warning?.message ?? '';
  return (
    message.includes('Use of eval') ||
    message.includes('dynamically imported by') ||
    message.includes('externalized for browser compatibility')
  );
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
  ],
  resolve: {
    alias: {
      'next/link': fileURLToPath(new URL('./src/next/link.tsx', import.meta.url)),
      'next/dynamic': fileURLToPath(new URL('./src/next/dynamic.tsx', import.meta.url)),
      'next/navigation': fileURLToPath(new URL('./src/next/navigation.ts', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      onwarn(warning, warn) {
        if (noisy(warning)) return;
        warn(warning);
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 9245,
    strictPort: true,
  },
});
