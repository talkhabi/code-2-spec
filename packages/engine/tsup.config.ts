import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.ts', mcp: 'src/mcp.ts', index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: false,
  clean: true,
  splitting: true,
  removeNodeProtocol: false,
  banner: { js: '#!/usr/bin/env node' },
  // bundle the dashboard so a global install of the engine serves it
  onSuccess: 'rm -rf dist/dashboard && (cp -R ../dashboard/dist dist/dashboard 2>/dev/null || true)',
});
