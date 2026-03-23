FROM ghcr.io/cross-rs/aarch64-unknown-linux-gnu:main

# The base image has OpenSSL 1.1 but SQLCipher needs OpenSSL 3.x (EVP_MAC, OSSL_PARAM).
# Build OpenSSL 3 from source for aarch64.
RUN apt-get update && apt-get install -y wget perl make && \
    wget -q https://github.com/openssl/openssl/releases/download/openssl-3.4.1/openssl-3.4.1.tar.gz && \
    tar xf openssl-3.4.1.tar.gz && \
    cd openssl-3.4.1 && \
    ./Configure linux-aarch64 --prefix=/usr/local/aarch64-ssl --cross-compile-prefix=aarch64-linux-gnu- no-shared && \
    make -j$(nproc) && \
    make install_sw && \
    cd .. && rm -rf openssl-3.4.1 openssl-3.4.1.tar.gz && \
    rm -rf /var/lib/apt/lists/*

ENV OPENSSL_DIR=/usr/local/aarch64-ssl
ENV OPENSSL_STATIC=1
