import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
import { execFileSync } from 'child_process'
import type { Plugin } from 'vite'

// Single source of truth for the version shown in the UI footer:
// pull it straight from package.json and append the current git
// short SHA so the displayed "v X · build Y" stays accurate
// without us having to hand-edit any string.
const pkgJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'),
) as { version: string }
const APP_VERSION = pkgJson.version
let GIT_SHA = 'dev'
try {
  // execFileSync (not exec) avoids shell interpretation — args are
  // a fixed array, not a concatenated string, so there's nothing
  // for an attacker to inject. Inputs here are all static.
  GIT_SHA = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim()
} catch {
  // not a git checkout / git not installed — leave as "dev"
}

/**
 * Serve ORT WASM files from node_modules in dev.
 *
 * onnxruntime-web dynamically imports its WASM loader (.mjs) and fetches
 * the .wasm binary from the path set via `ort.env.wasm.wasmPaths`. In dev
 * mode Vite intercepts these requests and rejects them because /public
 * files can't be ES-imported. We resolve the imports to the real files in
 * node_modules so Vite serves them as regular modules.
 */
function ortWasmPlugin(): Plugin {
  const ortDist = path.resolve(__dirname, 'node_modules/onnxruntime-web/dist')
  return {
    name: 'ort-wasm-serve',
    enforce: 'pre',
    resolveId(source) {
      if (source.startsWith('/ort-wasm/')) {
        const file = source.replace('/ort-wasm/', '')
        const filePath = path.join(ortDist, file)
        if (fs.existsSync(filePath)) {
          return filePath
        }
      }
    },
    configureServer(server) {
      // Serve .wasm files (fetched, not imported) from node_modules
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/ort-wasm/') && req.url.endsWith('.wasm')) {
          const file = req.url.replace('/ort-wasm/', '').split('?')[0]
          const filePath = path.join(ortDist, file)
          if (fs.existsSync(filePath)) {
            res.setHeader('Content-Type', 'application/wasm')
            res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
            fs.createReadStream(filePath).pipe(res)
            return
          }
        }
        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __GIT_SHA__: JSON.stringify(GIT_SHA),
  },
  plugins: [react(), ortWasmPlugin()],
  server: {
    port: 8888,
    // Bind on all interfaces so the dev server is reachable from
    // other machines on the LAN (e.g. http://192.168.x.y:8888/app).
    // Defaults to localhost otherwise.
    host: '0.0.0.0',
    allowedHosts: ['dilla.thim.dev'],
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            // Ensure proxied API responses pass COEP=require-corp checks
            if (!proxyRes.headers['cross-origin-resource-policy']) {
              proxyRes.headers['cross-origin-resource-policy'] = 'same-origin';
            }
          });
        },
      },
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ['@jitsi/rnnoise-wasm', 'onnxruntime-web'],
  },
  worker: {
    format: 'es',
  },
})
