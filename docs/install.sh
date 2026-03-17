#!/bin/sh
set -e

REPO="dilla-chat/dilla-chat"
BINARY="dilla-server"
INSTALL_DIR="/usr/local/bin"

detect_platform() {
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)

  case "$OS" in
    linux)  OS="linux" ;;
    darwin) OS="darwin" ;;
    *)      echo "Unsupported OS: $OS" >&2; exit 1 ;;
  esac

  case "$ARCH" in
    x86_64|amd64)   ARCH="amd64" ;;
    aarch64|arm64)   ARCH="arm64" ;;
    *)               echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
  esac
}

main() {
  detect_platform

  ARCHIVE="${BINARY}-${OS}-${ARCH}.tar.gz"
  URL="https://github.com/${REPO}/releases/latest/download/${ARCHIVE}"

  echo "Downloading ${BINARY} for ${OS}/${ARCH}..."
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" -o "$TMP/$ARCHIVE"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$TMP/$ARCHIVE" "$URL"
  else
    echo "Error: curl or wget is required" >&2
    exit 1
  fi

  tar xzf "$TMP/$ARCHIVE" -C "$TMP"
  chmod +x "$TMP/${BINARY}-${OS}-${ARCH}"

  if [ -w "$INSTALL_DIR" ]; then
    mv "$TMP/${BINARY}-${OS}-${ARCH}" "$INSTALL_DIR/$BINARY"
  else
    echo "Installing to $INSTALL_DIR (requires sudo)..."
    sudo mv "$TMP/${BINARY}-${OS}-${ARCH}" "$INSTALL_DIR/$BINARY"
  fi

  echo ""
  echo "dilla-server installed to $INSTALL_DIR/$BINARY"
  echo ""
  echo "Quick start:"
  echo "  dilla-server                          # Start with defaults"
  echo "  DILLA_INSECURE=true dilla-server      # Start without TLS (dev mode)"
  echo ""
  echo "Documentation: https://github.com/${REPO}"
}

main
