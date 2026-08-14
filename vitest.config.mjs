import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['tests/ui/**/*.test.{jsx,js,mjs}'],
    setupFiles: ['tests/ui/setup.mjs'],
    globals: false,
  },
});
