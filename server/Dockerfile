# Stage 1: Build
FROM golang:1.24-alpine AS builder

RUN apk add --no-cache gcc musl-dev sqlite-dev

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=1 go build -ldflags="-s -w" -o slimcord-server ./cmd/slimcord-server/

# Stage 2: Runtime
FROM alpine:3.21

RUN apk add --no-cache ca-certificates sqlite-libs

COPY --from=builder /build/slimcord-server /usr/local/bin/slimcord-server

EXPOSE 8080 8081
VOLUME /data

ENTRYPOINT ["slimcord-server"]
CMD ["--data-dir", "/data"]
