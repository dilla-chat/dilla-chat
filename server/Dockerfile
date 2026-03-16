# Stage 1: Build
FROM golang:1.24-alpine AS builder

RUN apk add --no-cache gcc musl-dev sqlite-dev

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=1 go build -ldflags="-s -w" -o dilla-server ./cmd/dilla-server/

# Stage 2: Runtime
FROM alpine:3.21

RUN apk add --no-cache ca-certificates sqlite-libs

COPY --from=builder /build/dilla-server /usr/local/bin/dilla-server

EXPOSE 8080 8081
VOLUME /data

ENTRYPOINT ["dilla-server"]
CMD ["--data-dir", "/data"]
