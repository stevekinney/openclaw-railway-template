# syntax=docker/dockerfile:1.28.0@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b

# Tailscale runs inside this container, next to the Gateway; only its two
# binaries are taken from the official image. Dependabot tracks this pin.
FROM tailscale/tailscale:v1.102.5@sha256:c507f3a2a6ab1cabd8d809b98edeb41edbd5c3fb6ad9632ffd098b4c7d0b4065 AS tailscale

# The OpenClaw release this template deploys. This line is the single source of
# truth for the version: an upgrade changes the tag and digest together and
# nothing else. See documentation/UPGRADING.md.
FROM ghcr.io/openclaw/openclaw:2026.9.9@sha256:7f10d5cc975a90b65192eaa099454fe33ce8ce2390806c61c65cd868e9ef730d

# Railway mounts volumes owned by root, so the container starts as root only
# long enough for scripts/entrypoint.sh to prepare /data. The entrypoint then
# drops to the image's unprivileged `node` user before OpenClaw runs.
# hadolint ignore=DL3002,DL3066
USER root

# The Gateway listens on loopback only (gateway.tailscale.mode=serve requires
# it), on 18789. Tailscale Serve, which OpenClaw manages, is the only way in.
# Railway's deploy health check reaches it through the sidecar's relay on 8080,
# the PORT Railway injects when a service sets none.
# OPENCLAW_HOME relocates every OpenClaw path default (state, config, agents,
# credentials, workspace) under the Railway volume: /data/.openclaw.
# OPENCLAW_SUPERVISOR_MODE=external tells OpenClaw that Railway owns the process
# lifecycle, which refuses in-place self-updates and service installs.
ENV OPENCLAW_HOME=/data \
    OPENCLAW_GATEWAY_PORT=18789 \
    OPENCLAW_SUPERVISOR_MODE=external \
    OPENCLAW_NO_AUTO_UPDATE=1

# GitHub CLI, which OpenClaw drives for Settings > Profile > GitHub connections
# (device sign-in). OpenClaw keeps each connection's credentials under the state
# directory, so they persist on the volume. Pinned release, verified against the
# checksums GitHub publishes with it; shell variables, not ARGs, so no Railway
# variable can reach the build.
RUN set -eu; \
    gh_version=2.102.0; \
    architecture="$(dpkg --print-architecture)"; \
    case "$architecture" in \
      amd64) checksum=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386 ;; \
      arm64) checksum=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484 ;; \
      *) echo "no GitHub CLI checksum for $architecture" >&2; exit 1 ;; \
    esac; \
    archive="/tmp/gh_${gh_version}_linux_${architecture}.tar.gz"; \
    curl -fsSL -o "$archive" "https://github.com/cli/cli/releases/download/v${gh_version}/gh_${gh_version}_linux_${architecture}.tar.gz"; \
    printf '%s  %s\n' "$checksum" "$archive" > /tmp/gh.sha256; \
    sha256sum -c /tmp/gh.sha256; \
    tar -xzf "$archive" -C /tmp; \
    install -m 0755 "/tmp/gh_${gh_version}_linux_${architecture}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh*; \
    gh --version

# From Debian stable: jq and tmux for the trello and tmux skills; procps and
# file, which Homebrew needs; and ImageMagick with libheif, which OpenClaw's
# image processor falls back to for formats its built-in decoder can't read,
# such as iPhone HEIC photos (without it they fail with "Image processor
# unavailable"). Not pinned to exact versions: a Debian security update removes
# the previous version from the mirror, so an exact pin would eventually break
# every build. (The grep fails the build if ImageMagick can't read HEIC, so the
# pipe needs no pipefail.)
# hadolint ignore=DL3008,DL4006
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq tmux procps file imagemagick libheif1 \
 && rm -rf /var/lib/apt/lists/* \
 && jq --version \
 && tmux -V \
 && convert -list format | grep -E "^ *HEIC[*] +HEIC +r"

# gog, the Google Workspace CLI for the gog skill. Pinned release, verified
# against the project's published checksums.
RUN set -eu; \
    gog_version=0.43.0; \
    architecture="$(dpkg --print-architecture)"; \
    case "$architecture" in \
      amd64) checksum=a16d4b8b917e36b96b09b30ecb7a5049d06ff1e88b856a101eec12b86b33fe05 ;; \
      arm64) checksum=f66e3c9ab7664b7633d57d2d5303e0db75deb4045e1b32c3493c0d8ba68a70f7 ;; \
      *) echo "no gog checksum for $architecture" >&2; exit 1 ;; \
    esac; \
    archive="/tmp/gogcli_${gog_version}_linux_${architecture}.tar.gz"; \
    curl -fsSL -o "$archive" "https://github.com/steipete/gogcli/releases/download/v${gog_version}/gogcli_${gog_version}_linux_${architecture}.tar.gz"; \
    printf '%s  %s\n' "$checksum" "$archive" > /tmp/gog.sha256; \
    sha256sum -c /tmp/gog.sha256; \
    mkdir /tmp/gogcli; \
    tar -xzf "$archive" -C /tmp/gogcli; \
    install -m 0755 /tmp/gogcli/gog /usr/local/bin/gog; \
    rm -rf /tmp/gogcli /tmp/gog.sha256 "$archive"; \
    gog --version

# Codex CLI for the coding-agent skill. The base image already ships
# @openai/codex for OpenClaw's Codex runtime, so link that copy onto PATH; it
# follows OpenClaw's own pin on every upgrade. (`set --` word-splits the find
# result on purpose, to check there is exactly one match.)
# hadolint ignore=SC2086
RUN set -eu; \
    codex_script="$(find /app/node_modules/.pnpm -path '*/@openai+codex@*/node_modules/@openai/codex/bin/codex.js' -print)"; \
    set -- $codex_script; \
    [ "$#" = 1 ] || { echo "expected exactly one bundled Codex CLI, found: $codex_script" >&2; exit 1; }; \
    ln -s "$codex_script" /usr/local/bin/codex; \
    codex --version

# Claude Code for the coding-agent skill: a pinned baseline in
# tools/package-lock.json, so a fresh deploy works. `as-node claude install
# stable` puts a self-updating copy on the volume that takes precedence (see
# documentation/TOOLS.md). Its postinstall script copies the native binary
# for this architecture into place; tools/package.json approves only that
# package's install script (npm 12 blocks dependency scripts by default).
COPY tools/package.json tools/package-lock.json /opt/tools/
RUN npm ci --prefix /opt/tools --omit=dev --no-audit --no-fund \
 && ln -s /opt/tools/node_modules/.bin/claude /usr/local/bin/claude \
 && claude --version

# Homebrew, for installing and updating tools at runtime. Its prefix must be
# /home/linuxbrew/.linuxbrew for prebuilt bottles to pour, so that path is a
# symlink to /data/linuxbrew on the volume, and the entrypoint copies this seed
# there on first boot. After that, Homebrew and everything it installs live on
# the volume and update themselves; the image only pins the starting point.
# Installed as node (Homebrew refuses root), and run once so its portable Ruby
# is vendored into the seed and first boot needs no network.
RUN install -d -o node -g node /home/linuxbrew
# hadolint ignore=DL3066
USER node
RUN git clone --depth 1 --branch 7.0.8 https://github.com/Homebrew/brew /home/linuxbrew/.linuxbrew/Homebrew \
 && mkdir /home/linuxbrew/.linuxbrew/bin \
 && ln -s ../Homebrew/bin/brew /home/linuxbrew/.linuxbrew/bin/brew \
 && HOME=/tmp HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_AUTO_UPDATE=1 /home/linuxbrew/.linuxbrew/bin/brew vendor-install ruby \
 && HOME=/tmp HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_AUTO_UPDATE=1 /home/linuxbrew/.linuxbrew/bin/brew --version \
 && rm -rf /tmp/.cache
# Back to root for the entrypoint, which drops to node itself.
# hadolint ignore=DL3002,DL3066
USER root
RUN mv /home/linuxbrew/.linuxbrew /opt/homebrew-seed \
 && ln -s /data/linuxbrew /home/linuxbrew/.linuxbrew

COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscaled /usr/local/bin/

# The Gateway's name in OpenClaw's machine picker. OpenClaw 2026.9.8 falls back
# to the container hostname, which Railway changes on every deploy; this patch
# reads OPENCLAW_MACHINE_DISPLAY_NAME first. The entrypoint defaults it to the
# Tailscale machine name; set it as a Railway variable to choose another.
# Keep this patch in .dockerignore's build-context allowlist.
COPY scripts/patch-machine-display-name.mjs /usr/local/lib/openclaw-railway/patch-machine-display-name.mjs
RUN node /usr/local/lib/openclaw-railway/patch-machine-display-name.mjs

COPY config/openclaw.seed.json /etc/openclaw-railway/openclaw.seed.json
COPY scripts/entrypoint.sh /usr/local/bin/openclaw-railway-entrypoint
COPY scripts/sidecar.mjs /usr/local/lib/openclaw-railway/sidecar.mjs
# `railway ssh` opens a root shell. `as-node <command>` runs a command as the
# Gateway's user, so tool logins (for example `as-node gog auth add …`) don't
# leave root-owned files the agent can't read. The openclaw and brew wrappers in
# /usr/local/sbin (first on PATH) do the same automatically.
COPY scripts/as-node.sh /usr/local/bin/as-node
COPY scripts/openclaw-as-node.sh /usr/local/sbin/openclaw
COPY scripts/brew-as-node.sh /usr/local/sbin/brew
# gog-login: Google sign-in for the gog skill through the tailnet instead of
# a 127.0.0.1 redirect. See documentation/TOOLS.md.
COPY scripts/gog-login.sh /usr/local/bin/gog-login

RUN chmod 0444 /etc/openclaw-railway/openclaw.seed.json /usr/local/lib/openclaw-railway/sidecar.mjs \
 && chmod 0555 /usr/local/bin/openclaw-railway-entrypoint /usr/local/bin/as-node /usr/local/bin/gog-login /usr/local/sbin/openclaw /usr/local/sbin/brew \
 && node /app/openclaw.mjs --version \
 && tailscale version

# HOME is on the volume, so tool logins and settings kept under ~ (gog's Google
# tokens, Claude Code and Codex sessions) survive redeploys. PATH order, first
# match wins:
#   /usr/local/sbin          openclaw and brew wrappers; the OpenClaw CLI always
#                            matches the image's Gateway and can't be shadowed
#   /data/home/.local/bin    your tools on the volume: npm -g, Claude Code's
#                            self-updating native install
#   /home/linuxbrew/...      Homebrew on the volume
#   /usr/local/bin, ...      the image's pinned baseline
# NPM_CONFIG_PREFIX sends `npm install -g` to the volume instead of root-owned
# /usr/local.
ENV HOME=/data/home \
    PATH=/usr/local/sbin:/data/home/.local/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/home/node/.local/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NPM_CONFIG_PREFIX=/data/home/.local \
    HOMEBREW_NO_ANALYTICS=1 \
    HOMEBREW_NO_ENV_HINTS=1 \
    HOMEBREW_CACHE=/tmp/homebrew

# Tailscale, run by the entrypoint and sidecar as node in userspace mode
# (Railway has no TUN device). Its state (node key, certificates) is on the
# volume. The socket is the CLI's default path, so `tailscale` and OpenClaw
# find the daemon without flags.
#
# TS_DEBUG_MTU: Railway's container network has a 1316-byte MTU, smaller than a
# full Tailscale packet (1280 + 80 bytes of WireGuard/UDP/IPv6 overhead). Larger
# packets were silently lost, which made every TLS handshake take 0.6-1.7 s and
# capped transfers near 10 KB/s. 1236 = 1316 - 80, so tunnel packets fit.
ENV TS_STATE_DIR=/data/tailscale \
    TS_SOCKET=/var/run/tailscale/tailscaled.sock \
    TS_HOSTNAME=openclaw \
    TS_DEBUG_MTU=1236

# Replaces the base image's HEALTHCHECK, which would run OpenClaw code as root.
# Railway ignores Docker health checks; this one is for local `docker run`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT}/healthz`).then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]

EXPOSE 8080

# After the entrypoint drops privileges, this is the stock image's own startup:
# tini (PID 1) -> docker-entrypoint.mjs (runs Doctor migrations) -> Gateway.
ENTRYPOINT ["openclaw-railway-entrypoint", "tini", "-s", "--", "node", "/app/docker-entrypoint.mjs"]
# --bind, --tailscale, and --auth pin the network-facing settings so a later
# config edit or onboarding run cannot expose the Gateway differently or make it
# unauthenticated.
CMD ["node", "openclaw.mjs", "gateway", "--bind", "loopback", "--tailscale", "serve", "--auth", "token"]
