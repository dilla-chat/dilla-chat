# Stage 1: Build the web client
FROM node:22-alpine AS client-builder
WORKDIR /build/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: Build the Rust server
FROM rust:bookworm AS server-builder
WORKDIR /build
COPY server-rs/ server-rs/
COPY --from=client-builder /build/client/dist/ server-rs/dist/
WORKDIR /build/server-rs
RUN cargo build --release

# Stage 3: Runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=server-builder /build/server-rs/target/release/dilla-server /usr/local/bin/dilla-server
RUN mkdir -p /app/data
VOLUME /app/data
ENV DILLA_DATA_DIR=/app/data
EXPOSE 8080
ENTRYPOINT ["dilla-server"]
