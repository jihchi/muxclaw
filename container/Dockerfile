# Build stage: nq + zellij + CLI tools
ARG DENO_VERSION=2.8.3
FROM denoland/deno:${DENO_VERSION} AS tools-builder
WORKDIR /app

# Install nq, ripgrep, fd, and dependencies for zellij
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		nq \
		ripgrep \
		fd-find \
		curl \
		ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Install zellij
ARG ZELLIJ_VERSION=v0.44.3
RUN ARCH=$(dpkg --print-architecture) \
	&& case "$ARCH" in \
		amd64) ZELLIJ_ARCH="x86_64" ;; \
		arm64) ZELLIJ_ARCH="aarch64" ;; \
		*) echo "Unsupported architecture: $ARCH" && exit 1 ;; \
	esac \
	&& curl -fsSL "https://github.com/zellij-org/zellij/releases/download/${ZELLIJ_VERSION}/zellij-${ZELLIJ_ARCH}-unknown-linux-musl.tar.gz" \
		| tar -xz -C /usr/local/bin \
	&& chmod +x /usr/local/bin/zellij

# Build stage: pi coding agent
ARG PI_VERSION=0.79.10
FROM node:lts-slim AS pi-builder
ARG PI_VERSION
RUN npm install -g @earendil-works/pi-coding-agent@${PI_VERSION}

# Production stage
FROM denoland/deno:${DENO_VERSION}
WORKDIR /app

COPY --from=tools-builder /usr/bin/nq /usr/bin/nqtail /usr/bin/nqterm /usr/bin/rg /usr/bin/fdfind /usr/bin/
COPY --from=tools-builder /usr/local/bin/zellij /usr/local/bin/
RUN ln -s /usr/bin/fdfind /usr/bin/fd
COPY --from=pi-builder /usr/local/bin/node /usr/local/bin/
COPY --from=pi-builder /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js /usr/local/bin/pi

# Install dependencies
COPY deno.json deno.lock cli.ts container/layout.kdl .
RUN deno install --allow-import

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
