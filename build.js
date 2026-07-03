// Build script for EVChan Translator Chrome extension.
// Bundles ES modules with esbuild, copies static files, and packages a ZIP.

import { mkdir, copyFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const DIST = resolve('dist');
const ARTIFACT_NAME = 'evchan-translator.zip';

/** Recursively create a directory, ignoring EEXIST. */
async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

/** Synchronously remove a path, ignoring ENOENT. */
function rmRF(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/** Copy a single file, ensuring the destination directory exists. */
async function copy(src, dest) {
  await ensureDir(join(dest, '..'));
  await copyFile(src, dest);
}

/** Bundle an entry point with esbuild. */
async function bundle(entry, out) {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome90',
    outfile: out,
    sourcemap: false,
    minify: true,
    logLevel: 'info',
    // Strip debug exports from production builds
    define: { __EVCHAN_DEBUG__: 'false' },
  });
}

async function main() {
  console.log('Cleaning dist...');
  rmRF(DIST);

  // Create directory structure
  await Promise.all(['background', 'content', 'popup'].map((d) => ensureDir(join(DIST, d))));

  // Bundle entry points that use ES imports
  console.log('Bundling...');
  await Promise.all([
    bundle('background/background.js', join(DIST, 'background', 'background.js')),
    bundle('content/content.js', join(DIST, 'content', 'content.js')),
    bundle('popup/popup.js', join(DIST, 'popup', 'popup.js')),
    bundle('popup/popup.css', join(DIST, 'popup', 'popup.css')),
  ]);

  // Copy static files
  console.log('Copying files...');
  await Promise.all([
    copy('manifest.json', join(DIST, 'manifest.json')),
    copy('popup/popup.html', join(DIST, 'popup', 'popup.html')),
    copy('icons/icon.png', join(DIST, 'icon.png')),
  ]);

  // Package ZIP
  console.log('Packaging...');
  const isWin = process.platform === 'win32';
  if (isWin) {
    execSync(`cd dist; Compress-Archive -Path * -DestinationPath ..\\${ARTIFACT_NAME} -Force`, {
      shell: 'powershell.exe',
      stdio: 'inherit',
    });
  } else {
    execSync(`cd dist && zip -r ../${ARTIFACT_NAME} *`, { stdio: 'inherit' });
  }

  console.log(`Done → ${ARTIFACT_NAME}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
