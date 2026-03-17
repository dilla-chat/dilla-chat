FROM golang:1.24-alpine AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o dilla-turn .

FROM alpine:3.21
RUN apk add --no-cache ca-certificates
COPY --from=builder /build/dilla-turn /usr/local/bin/dilla-turn
EXPOSE 3478/udp 3478/tcp 5349/tcp 8081
ENTRYPOINT ["dilla-turn"]
