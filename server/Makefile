VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS := -ldflags "-s -w -X main.version=$(VERSION)"
CLIENT_DIR := ../client
WEBAPP_DIST := internal/webapp/dist

.PHONY: build dev test clean cross-compile docker webapp

# Build client web app, copy to embed dir, then build Go server
build: webapp
	go build $(LDFLAGS) -o bin/slimcord-server ./cmd/slimcord-server/

# Build only the web client and copy into the Go embed directory
webapp:
	cd $(CLIENT_DIR) && npm run build
	rm -rf $(WEBAPP_DIST)
	cp -r $(CLIENT_DIR)/dist $(WEBAPP_DIST)

dev: webapp
	go run ./cmd/slimcord-server/ --log-level debug --log-format text

test:
	go test ./... -v

clean:
	rm -rf bin/

# Note: CGO_ENABLED=1 is required for SQLCipher support.
# Cross-compiling with CGO requires appropriate C cross-compilers.
cross-compile:
	GOOS=linux   GOARCH=amd64 CGO_ENABLED=1 go build $(LDFLAGS) -o bin/slimcord-server-linux-amd64 ./cmd/slimcord-server/
	GOOS=linux   GOARCH=arm64 CGO_ENABLED=1 go build $(LDFLAGS) -o bin/slimcord-server-linux-arm64 ./cmd/slimcord-server/
	GOOS=darwin  GOARCH=amd64 CGO_ENABLED=1 go build $(LDFLAGS) -o bin/slimcord-server-darwin-amd64 ./cmd/slimcord-server/
	GOOS=darwin  GOARCH=arm64 CGO_ENABLED=1 go build $(LDFLAGS) -o bin/slimcord-server-darwin-arm64 ./cmd/slimcord-server/
	GOOS=windows GOARCH=amd64 CGO_ENABLED=1 go build $(LDFLAGS) -o bin/slimcord-server-windows-amd64.exe ./cmd/slimcord-server/

docker:
	docker build -t slimcord-server .
