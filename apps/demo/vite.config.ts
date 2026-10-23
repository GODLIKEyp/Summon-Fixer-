import { defineConfig } from 'vite';
import { summonFixer } from '@summon-fixer/vite-plugin';

export default defineConfig({
  plugins: [
    summonFixer(),
  ],
  esbuild: {
    jsx: 'automatic',
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
});
