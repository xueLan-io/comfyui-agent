import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the core-loop kernel test suite (src/agent/core-loop/).
 *
 * Separate from the main vitest.config.mjs (which scopes to tests/ui with
 * jsdom) so the two suites never affect each other's environment. Run via
 * `npm run test:core-loop`.
 *
 * The custom resolver maps NodeNext-style `.js` specifiers onto their `.ts`
 * sources — the kernel imports `./foo.js` because that is what tsc's NodeNext
 * resolution requires, and Vite needs the hint for the same file on disk being
 * `.ts`.
 */
const jsToTsResolver = {
  name: 'js-to-ts-resolver',
  async resolveId(source, importer, options) {
    if (source.endsWith('.js') && importer !== undefined && importer.endsWith('.ts')) {
      const tsSource = `${source.slice(0, -3)}.ts`;
      return this.resolve(tsSource, importer, options);
    }
    return null;
  },
};

export default defineConfig({
  plugins: [jsToTsResolver],
  test: {
    include: ['tests/core-loop/**/*.test.ts'],
    environment: 'node',
    // live.comfy.test.ts gates itself on COMFY_LIVE and skips otherwise.
    testTimeout: 30_000,
  },
});
