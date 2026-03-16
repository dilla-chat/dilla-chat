// Package webapp serves the embedded Dilla web client.
// The client dist/ directory is copied here at build time by the Makefile.
package webapp

import (
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
)

//go:embed dist/*
var distFS embed.FS

func init() {
	// Ensure common MIME types are registered
	mime.AddExtensionType(".js", "application/javascript")
	mime.AddExtensionType(".mjs", "application/javascript")
	mime.AddExtensionType(".css", "text/css")
	mime.AddExtensionType(".html", "text/html")
	mime.AddExtensionType(".json", "application/json")
	mime.AddExtensionType(".wasm", "application/wasm")
	mime.AddExtensionType(".svg", "image/svg+xml")
	mime.AddExtensionType(".png", "image/png")
	mime.AddExtensionType(".ico", "image/x-icon")
}

// Handler returns an http.Handler that serves the embedded web client.
// It serves static files from dist/ and falls back to index.html for SPA routes.
func Handler() http.Handler {
	// Strip the "dist/" prefix so files are served from root
	subFS, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic("webapp: embedded dist not found: " + err.Error())
	}

	fileServer := http.FileServer(http.FS(subFS))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		// Skip API, WebSocket, federation, health, and auth routes
		if strings.HasPrefix(path, "/api/") ||
			strings.HasPrefix(path, "/ws") ||
			strings.HasPrefix(path, "/federation/") ||
			path == "/health" ||
			path == "/auth" {
			http.NotFound(w, r)
			return
		}

		// Try to serve the file directly
		if path != "/" {
			cleanPath := strings.TrimPrefix(path, "/")
			if _, err := fs.Stat(subFS, cleanPath); err == nil {
				ext := filepath.Ext(cleanPath)
				if ct := mime.TypeByExtension(ext); ct != "" {
					w.Header().Set("Content-Type", ct)
				}
				// Hashed assets (e.g. /assets/index-abc123.js) can be cached long
				if strings.HasPrefix(path, "/assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				fileServer.ServeHTTP(w, r)
				return
			}
		}

		// SPA fallback: serve index.html for all unmatched routes
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})
}
