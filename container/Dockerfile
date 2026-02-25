ARG DENO_VERSION=2.7.1

# Build stage
FROM denoland/deno:${DENO_VERSION} AS builder
WORKDIR /app

# Install nq and dependencies for zellij
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		nq \
		curl \
		ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Install zellij
ARG ZELLIJ_VERSION=v0.43.1
RUN ARCH=$(dpkg --print-architecture) \
	&& case "$ARCH" in \
		amd64) ZELLIJ_ARCH="x86_64" ;; \
		arm64) ZELLIJ_ARCH="aarch64" ;; \
		*) echo "Unsupported architecture: $ARCH" && exit 1 ;; \
	esac \
	&& curl -fsSL "https://github.com/zellij-org/zellij/releases/download/${ZELLIJ_VERSION}/zellij-${ZELLIJ_ARCH}-unknown-linux-musl.tar.gz" \
		| tar -xz -C /usr/local/bin \
	&& chmod +x /usr/local/bin/zellij

# Production stage
FROM denoland/deno:${DENO_VERSION}
WORKDIR /app

COPY --from=builder /usr/bin/nq /usr/bin/nqtail /usr/bin/nqterm /usr/bin/
COPY --from=builder /usr/local/bin/zellij /usr/local/bin/

# Install dependencies
COPY deno.json deno.lock cli.ts container/layout.kdl .
RUN deno install

# Ensure XDG directories exist
RUN mkdir -p \
	/home/deno/.config/muxclaw \
	/home/deno/.local/share/muxclaw/messages \
	/home/deno/.local/state/muxclaw/queue/completed \
	/home/deno/.local/state/muxclaw/queue/failed \
	/workspace \
	&& chown -R deno:deno /home/deno /workspace

ENV HOME=/home/deno
ENV DENO_NO_UPDATE_CHECK=1
ENV SHELL=/bin/bash

USER deno

ENTRYPOINT ["zellij", "--layout", "/app/layout.kdl"]
