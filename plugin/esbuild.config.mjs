import esbuild from 'esbuild';
import { copyFileSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prod = process.argv.includes('production');

// Copy ORT runtime files from mvp-1
const mvpDir = join(__dirname, '..', 'mvp-1');
const libDir = join(__dirname, 'lib');
const ortFiles = readdirSync(mvpDir).filter(f => f.startsWith('ort-'));

for (const f of ortFiles) {
  copyFileSync(join(mvpDir, f), join(libDir, f));
}

// Copy AudioWorklet
copyFileSync(join(mvpDir, 'mic_worklet.js'), join(__dirname, 'mic_worklet.js'));

// Copy ORT bundle
copyFileSync(join(mvpDir, 'ort.bundle.min.mjs'), join(libDir, 'ort.bundle.min.mjs'));

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

// -- Build worker (module worker, fbank + ORT bundled) --
await esbuild.build({
  entryPoints: ['src/worker.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  outfile: 'worker.js',
  sourcemap: prod ? false : 'inline',
  minify: prod,
});

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
