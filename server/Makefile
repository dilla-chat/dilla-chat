VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS := -ldflags "-s -w -X main.version=$(VERSION)"
CLIENT_DIR := ../client
WEBAPP_DIST := internal/webapp/dist

.PHONY: build dev test clean cross-compile docker webapp

# Build client web app, copy to embed dir, then build Go server
build: webapp
	go build $(LDFLAGS) -o bin/dilla-server ./cmd/dilla-server/

# Build only the web client and copy into the Go embed directory
webapp:
	cd $(CLIENT_DIR) && npm run build
	rm -rf $(WEBAPP_DIST)
	cp -r $(CLIENT_DIR)/dist $(WEBAPP_DIST)

dev: webapp
	go run ./cmd/dilla-server/ --log-level debug --log-format text

test:
	go test ./... -v

clean:
	rm -rf bin/

# Note: CGO_ENABLED=1 is required for SQLCipher support.
# Cross-compiling with CGO requires appropriate C cross-compilers.
cross-compile:
	GOOS=linux   GOARCH=amd64 CGO_ENABLED=1 go build $(LDFLAGS) -o bin/dilla-server-linux-amd64 ./cmd/dilla-server/
	GOOS=linux   GOARCH=arm64 CGO_ENABLED=1 go build $(LDFLAGS) -o bin/dilla-server-linux-arm64 ./cmd/dilla-server/
	GOOS=darwin  GOARCH=amd64 CGO_ENABLED=1 go build $(LDFLAGS) -o bin/dilla-server-darwin-amd64 ./cmd/dilla-server/
	GOOS=darwin  GOARCH=arm64 CGO_ENABLED=1 go build $(LDFLAGS) -o bin/dilla-server-darwin-arm64 ./cmd/dilla-server/
	GOOS=windows GOARCH=amd64 CGO_ENABLED=1 go build $(LDFLAGS) -o bin/dilla-server-windows-amd64.exe ./cmd/dilla-server/

docker:
	docker build -t dilla-server .
