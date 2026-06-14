import esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prod = process.argv.includes('production');

// Read version from package.json
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
const VERSION = pkg.version;

// Build output directory
const OUT_DIR = join(__dirname, 'plugin');

// Obsidian plugin target directory (auto-deploy)
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || join(__dirname, '../arvin-notes');
const DEPLOY_DIR = join(OBSIDIAN_VAULT, '.obsidian/plugins/vermilion-voice');

// Ensure output directory exists
if (!existsSync(OUT_DIR)) {
  mkdirSync(OUT_DIR, { recursive: true });
}

// -- Build workers (dual Worker: VAD + ASR/PUNC) --
const workerOpts = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  sourcemap: prod ? false : 'inline',
  minify: prod,
};

await esbuild.build({ ...workerOpts, entryPoints: ['src/worker-vad.ts'], outfile: 'plugin/worker-vad.js' });
await esbuild.build({ ...workerOpts, entryPoints: ['src/worker-asr.ts'], outfile: 'plugin/worker-asr.js' });

// -- Build main plugin --
await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2020',
  outfile: 'plugin/main.js',
  external: ['obsidian', 'electron'],
  sourcemap: prod ? false : 'inline',
  minify: prod,
  treeShaking: true,
});

// Copy static files from assets/ to plugin/
const ASSETS_DIR = join(__dirname, 'assets');
for (const f of ['manifest.json', 'styles.css', 'models.json', 'settings.json', 'mic_worklet.js']) {
  const src = join(ASSETS_DIR, f);
  if (existsSync(src)) {
    copyFileSync(src, join(OUT_DIR, f));
  }
}

// Copy runtime vendored files (loaded at runtime, not bundled by esbuild)
for (const f of ['flac.js']) {
  const src = join(__dirname, 'lib', f);
  if (existsSync(src)) {
    copyFileSync(src, join(OUT_DIR, f));
  }
}

// Write version into manifest.json for consistency
const manifestPath = join(OUT_DIR, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
manifest.version = VERSION;
writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');

// -- Create release zip --
if (prod) {
  const zipName = `${pkg.name}-${VERSION}.zip`;
  const zipPath = join(__dirname, zipName);
  try {
    if (process.platform === 'win32') {
      execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${OUT_DIR}\\*' -DestinationPath '${zipPath}' -Force"`, { stdio: 'pipe' });
    } else {
      execSync(`cd "${OUT_DIR}" && zip -r "${zipPath}" .`, { stdio: 'pipe' });
    }
    // Remove old zips to keep only the current one
    console.log(`[vermilion-voice] Release zip: ${zipName}`);
  } catch (e) {
    console.error('[vermilion-voice] Failed to create zip:', e.message);
  }
}

// Auto-deploy to Obsidian plugins directory
if (existsSync(DEPLOY_DIR)) {
  for (const f of ['main.js', 'worker-vad.js', 'worker-asr.js', 'mic_worklet.js', 'models.json', 'settings.json', 'styles.css', 'manifest.json', 'flac.js']) {
    const src = join(OUT_DIR, f);
    if (existsSync(src)) {
      copyFileSync(src, join(DEPLOY_DIR, f));
    }
  }
  console.log(`[vermilion-voice] Deployed to ${DEPLOY_DIR}`);
}

console.log('[vermilion-voice] Build complete');
