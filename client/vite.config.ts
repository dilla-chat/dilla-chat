import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
import type { Plugin } from 'vite'

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
  plugins: [react(), ortWasmPlugin()],
  server: {
    port: 8888,
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
