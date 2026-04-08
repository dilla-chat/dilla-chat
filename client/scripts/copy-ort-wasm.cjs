// Copies the onnxruntime-web runtime files (.wasm + .mjs glue) into the
// Vite public/ directory so they are served at /ort-wasm/* in dev and
// bundled into the production build alongside the rest of the static
// assets. The voice isolation Worker points ort.env.wasm.wasmPaths at
// '/ort-wasm/' so it picks them up at runtime.
//
// Run automatically as part of `postinstall`. Safe to re-run idempotently.

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist');
const dst = path.join(__dirname, '..', 'public', 'ort-wasm');

if (!fs.existsSync(src)) {
  console.warn(`[copy-ort-wasm] source not found: ${src} — skipping`);
  process.exit(0);
}

fs.mkdirSync(dst, { recursive: true });

let count = 0;
for (const file of fs.readdirSync(src)) {
  if (file.endsWith('.wasm') || file.endsWith('.mjs')) {
    fs.copyFileSync(path.join(src, file), path.join(dst, file));
    count += 1;
  }
}

console.log(`[copy-ort-wasm] copied ${count} ORT runtime files to ${dst}`);
