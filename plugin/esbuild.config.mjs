import esbuild from 'esbuild';
import { copyFileSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prod = process.argv.includes('production');

const mvpDir = join(__dirname, '..', 'mvp-1');
const libDir = join(__dirname, 'lib');

// Copy AudioWorklet
copyFileSync(join(mvpDir, 'mic_worklet.js'), join(__dirname, 'mic_worklet.js'));

// ORT bundle: committed ort.bundle.min.mjs (npm wasm-only build, 468KB)
// ort-wasm-simd-threaded.wasm (~11MB) is downloaded at runtime from CDN

// Copy fbank + streaming_fbank (bundled into worker)
// streaming_fbank.js imports from '../poc-2/fbank.js' — rewrite to local path
copyFileSync(
  join(__dirname, '..', 'poc-2', 'fbank.js'),
  join(libDir, 'fbank.js')
);
let fbankCode = readFileSync(
  join(__dirname, '..', 'poc-3', 'streaming_fbank.js'), 'utf-8'
);
fbankCode = fbankCode.replace("from '../poc-2/fbank.js'", "from './fbank.js'");
writeFileSync(join(libDir, 'streaming_fbank.js'), fbankCode);

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

console.log('[voice-solo] Build complete');
