import esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prod = process.argv.includes('production');

// Obsidian plugin target directory (auto-deploy)
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || join(__dirname, '../../../arvin-notes');
const DEPLOY_DIR = join(OBSIDIAN_VAULT, '.obsidian/plugins/voice-solo');

// ORT bundle: committed ort.bundle.min.mjs (npm wasm-only build, 468KB)
// ort-wasm-simd-threaded.wasm (~11MB) is downloaded at runtime from CDN

// Copy styles
copyFileSync(join(__dirname, 'styles.css'), join(__dirname, 'styles.css'));

// Copy models config
copyFileSync(join(__dirname, 'models.json'), join(__dirname, 'models.json'));

// -- Build workers (dual Worker: VAD + ASR/PUNC) --
const workerOpts = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  sourcemap: prod ? false : 'inline',
  minify: prod,
};

await esbuild.build({ ...workerOpts, entryPoints: ['src/worker-vad.ts'], outfile: 'worker-vad.js' });
await esbuild.build({ ...workerOpts, entryPoints: ['src/worker-asr.ts'], outfile: 'worker-asr.js' });

// -- Build main plugin --
await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2020',
  outfile: 'main.js',
  external: ['obsidian', 'electron'],
  sourcemap: prod ? false : 'inline',
  minify: prod,
  treeShaking: true,
});

// Auto-deploy to Obsidian plugins directory
if (existsSync(DEPLOY_DIR)) {
  for (const f of ['main.js', 'worker-vad.js', 'worker-asr.js', 'settings.json', 'styles.css', 'manifest.json']) {
    const src = join(__dirname, f);
    if (existsSync(src)) {
      copyFileSync(src, join(DEPLOY_DIR, f));
    }
  }
  console.log(`[voice-solo] Deployed to ${DEPLOY_DIR}`);
}

console.log('[voice-solo] Build complete');
