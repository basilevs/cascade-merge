import * as esbuild from 'esbuild';
import { rmSync } from 'fs';

// 1. Clean the dist folder (replaces 'rm dist/*.js')
try {
  rmSync('dist', { recursive: true, force: true });
} catch (e) {
  // Ignore errors if folder doesn't exist
}

// 2. Build everything in one go
await esbuild.build({
  // Define your entry points. Logic is included automatically if imported by these.
  entryPoints: ['src/main.ts', 'src/post.ts'],
  
  bundle: true,          // Bundle dependencies
  splitting: true,       // Share code between main and post via a third file
  minify: false,         // Set to true for smaller output
  sourcemap: false,
  
  platform: 'node',
  format: 'esm',         // Required for splitting
  target: 'node20',
  outdir: 'dist/',
  
  // The banner fix for ESM compatibility
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});

console.log('✅ Build complete');