VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS := -ldflags "-s -w -X main.version=$(VERSION)"

.PHONY: build test clean docker

build:
	CGO_ENABLED=0 go build $(LDFLAGS) -o bin/dilla-turn .

test:
	go test ./... -v

clean:
	rm -rf bin/

docker:
	docker build -t dilla-turn .
