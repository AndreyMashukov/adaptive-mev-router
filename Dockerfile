# Reproducible build/test environment for adaptive-mev-router.
#
# Build:
#   docker build -t adaptive-mev-router .
#
# Run unit tests (Yul + Huff parity foreach):
#   docker run --rm adaptive-mev-router
#
# Run fork tests (needs MAINNET_RPC_URL; falls back to a public node):
#   docker run --rm -e HARDHAT_FORK=1 -e MAINNET_RPC_URL=https://your-rpc adaptive-mev-router \
#       npx hardhat test test/GreedySimulatorV2.fork.test.js test/MEV_V2_v4_nested.fork.test.js

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        git \
    && rm -rf /var/lib/apt/lists/*

# Install huffc (huff-rs).
# The tagged 0.3.2 release has no binary assets — the published binaries live under
# the rolling `nightly` tag. Pin the artefact URL so the image build is reproducible.
ARG HUFF_RELEASE=nightly
ARG HUFF_ASSET=huff_nightly_linux_amd64.tar.gz
RUN set -eux; \
    curl -fsSL -o /tmp/huff.tar.gz \
        "https://github.com/huff-language/huff-rs/releases/download/${HUFF_RELEASE}/${HUFF_ASSET}"; \
    mkdir -p /tmp/huff; \
    tar -xzf /tmp/huff.tar.gz -C /tmp/huff; \
    find /tmp/huff -type f -name 'huffc' -exec mv {} /usr/local/bin/huffc \;; \
    chmod +x /usr/local/bin/huffc; \
    rm -rf /tmp/huff /tmp/huff.tar.gz; \
    huffc --version

WORKDIR /workspace

# Dependencies layer — cached as long as package*.json doesn't change.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Sources + compile.
COPY . .
RUN npx hardhat compile \
    && mkdir -p artifacts \
    && huffc contracts/MEV_V2.huff -r > artifacts/MEV_V2_huff.bin

# Default: run the unit suite (both Yul and Huff variants).
CMD ["npx", "hardhat", "test", "test/MEV_V2.test.js", "test/RouteSimulatorV2.test.js"]
