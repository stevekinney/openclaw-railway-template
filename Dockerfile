# syntax=docker/dockerfile:1.28.0@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime-node

# Tailscale runs inside this container, next to the Gateway; only its two
# binaries are taken from the official image. Dependabot tracks this pin.
FROM tailscale/tailscale:v1.102.5@sha256:c507f3a2a6ab1cabd8d809b98edeb41edbd5c3fb6ad9632ffd098b4c7d0b4065 AS tailscale

# The release supplies the base image and existing plugin selection.
FROM ghcr.io/openclaw/openclaw:2026.10.5@sha256:f40d1e66fd14d8c5b49c832f4100f83b53fdc01f5108f7db11de38fd0ee6dbe5 AS openclaw-release

# Rebuild the pinned release with the reviewed cold-capture engine fix. Keep the
# patch tied to this source revision; an upstream upgrade must revalidate it.
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun
FROM node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4 AS openclaw-source
WORKDIR /app
ENV GIT_COMMIT=1b58cb9a1b4f4353e1add63c8506db4d890962e8 \
    OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 \
    OPENCLAW_PREFER_PNPM=1 \
    OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=4352
ADD --checksum=sha256:3f3f54c80914d8de5f5370ec417cece495d9dd9a2d329b36b63764bafa80d2c7 https://codeload.github.com/openclaw/openclaw/tar.gz/1b58cb9a1b4f4353e1add63c8506db4d890962e8 /tmp/openclaw-source.tar.gz
RUN tar -xzf /tmp/openclaw-source.tar.gz --strip-components=1 -C /app \
 && rm /tmp/openclaw-source.tar.gz \
 && corepack enable
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=openclaw-release /app/dist/build-info.json /tmp/release-build-info.json
COPY scripts/check-slack-routing.ts /tmp/check-slack-routing.ts
RUN node /tmp/check-slack-routing.ts identity /app /tmp/release-build-info.json
COPY scripts/openclaw-plugin-capture.patch /tmp/openclaw-plugin-capture.patch
ADD --checksum=sha256:1d572eb84e2a12c88c23848a97238bb18ad4a131f395aff9b3f57b3e3a42cb3f https://raw.githubusercontent.com/stevekinney/openclaw-plugin-slack-workspace/ee274d16a87536b97770260fa17f08ee7e80af68/docs/openclaw-routing.patch /tmp/openclaw-slack-routing.patch
RUN git apply --check /tmp/openclaw-plugin-capture.patch \
 && git apply /tmp/openclaw-plugin-capture.patch \
 && git apply --check /tmp/openclaw-slack-routing.patch \
 && git apply /tmp/openclaw-slack-routing.patch \
 && node -e 'const fs = require("node:fs"); const file = "package.json"; const manifest = JSON.parse(fs.readFileSync(file, "utf8")); const command = "scripts/tsdown-build.mts"; if (manifest.scripts["build:docker"].split(command).length !== 2) throw new Error("expected one runtime compiler invocation"); manifest.scripts["build:docker"] = manifest.scripts["build:docker"].replace(command, command + " --concurrency 1"); fs.writeFileSync(file, JSON.stringify(manifest));' \
 && pnpm install --frozen-lockfile \
 && node /tmp/check-slack-routing.ts dependencies /app
FROM openclaw-source AS openclaw-source-tests
RUN pnpm test src/commands/doctor-config-flow*.test.ts src/flows/doctor-health-contributions.test.ts src/flows/doctor-health-contributions.auth-import-order.test.ts src/flows/doctor-health-contributions.availability.test.ts src/flows/doctor-health-contributions.legacy-state.test.ts src/agents/prepared-model-runtime.copilot.integration.test.ts src/agents/prepared-model-runtime.startup-registry.test.ts src/agents/prepared-model-runtime.plugin-context.test.ts src/agents/prepared-model-runtime.registry-borrow.test.ts src/plugins/loader.gateway-borrow.test.ts src/plugins/loader.async-preparation.test.ts src/gateway/server-plugins.test.ts src/gateway/server-startup-plugins.test.ts src/gateway/server-plugin-reload-recovery.test.ts src/cli/plugins-cli.install-multiple.test.ts src/cli/plugins-cli.install.test.ts src/cli/plugins-cli.lazy.test.ts --maxWorkers=1 \
 && pnpm test src/infra/npm-install-env.test.ts src/infra/sqlite-snapshot-prefetch.test.ts src/infra/sqlite-snapshot-cow.test.ts src/infra/sqlite-snapshot.file-id.test.ts src/infra/sqlite-snapshot.transfer.test.ts src/infra/update-database-restore.test.ts src/snapshot/git-backup-codec.test.ts src/snapshot/local-repository.test.ts src/infra/update-database-generations.test.ts src/infra/update-database-backup.test.ts src/infra/update-recovery-doctor-retention.test.ts packages/worker-runtime/src/worker-task-server.test.ts src/plugins/plugin-generation-worker-codec.test.ts src/plugins/plugin-generation-worker.test.ts src/plugins/plugin-generation-worker.notifications.test.ts src/plugins/plugin-instance-module-loader.failed-acquisition.test.ts src/plugins/loader.native-module-loader.test.ts src/plugins/path-safety.test.ts src/plugins/prune-docker-plugin-dist.test.ts src/plugins/doctor-contract-registry.custody.test.ts src/state/openclaw-state-db-publication-authority.test.ts src/plugins/plugin-generation-artifact.hashing.test.ts src/plugins/plugin-generation-artifact.admission.test.ts src/plugins/plugin-native-admission-module-graph.test.ts src/plugins/plugin-generation-artifact.native-reference.test.ts src/plugins/plugin-source-capture-directory.test.ts src/plugins/plugin-source-capture-recovery.test.ts src/plugins/plugin-generation-artifact.streaming.test.ts src/plugins/plugin-source-file.copy.test.ts test/docker-entrypoint.test.ts src/state/openclaw-state-db-readonly.snapshot-admission.test.ts src/state/openclaw-state-db-readonly.signal-custody.test.ts --maxWorkers=1 \
 && pnpm test extensions/codex/doctor-contract-api.test.ts extensions/codex/doctor-contract-api.cold.test.ts extensions/codex/worker-entry-contract.test.ts extensions/codex/session-history-worker-runtime.test.ts --maxWorkers=1 \
 && node scripts/run-vitest.mjs src/plugins/hooks.resolve-inbound-route.test.ts src/channels/session.test.ts src/infra/outbound/session-context.test.ts src/infra/system-events.test.ts --maxWorkers=1 \
 && node scripts/run-vitest.mjs --config test/vitest/vitest.extension-slack.config.ts --maxWorkers=1
FROM openclaw-source AS openclaw-build
COPY --from=openclaw-release /app/dist/extensions/ /tmp/release-extensions/
RUN set -eu; \
    selected_plugins="$(node -e 'process.stdout.write([...new Set([...require("node:fs").readdirSync("/tmp/release-extensions"), "codex", "acpx", "slack", "lobster", "firecrawl", "exa", "typesafe"])].join(" "))')"; \
    OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS="$selected_plugins" pnpm build:docker; \
    node --import ./scripts/tsx.mjs --input-type=module -e 'import fs from "node:fs"; import { execFileSync } from "node:child_process"; import { generateNpmPackageLock, packageJsonForNpmLock, readNpmLockOverrides } from "./scripts/generate-npm-package-lock.mts"; import { resolveNpmRunner } from "./scripts/npm-runner.mts"; for (const plugin of ["acpx", "slack", "lobster", "firecrawl", "exa", "typesafe"]) { const directory = "/tmp/" + plugin + "-production-dependencies"; fs.mkdirSync(directory); const { name, version, dependencies, optionalDependencies } = JSON.parse(fs.readFileSync("extensions/" + plugin + "/package.json", "utf8")); const manifest = { name, version, dependencies, optionalDependencies }; fs.writeFileSync(directory + "/package.json", JSON.stringify(packageJsonForNpmLock(manifest, readNpmLockOverrides(manifest, directory)))); fs.writeFileSync(directory + "/package-lock.json", generateNpmPackageLock(directory, { installStrategy: "shallow" })); const runner = resolveNpmRunner({ npmArgs: ["ci", "--install-strategy=shallow", "--omit=dev", "--omit=peer", "--ignore-scripts", "--no-fund", "--workspaces=false"] }); execFileSync(runner.command, runner.args, { cwd: directory, stdio: "inherit" }); const audit = resolveNpmRunner({ npmArgs: ["audit", "--omit=dev", "--omit=peer", "--audit-level=low", "--workspaces=false"] }); execFileSync(audit.command, audit.args, { cwd: directory, stdio: "inherit" }); }'; \
    pnpm ui:build; \
    node -e 'const fs = require("node:fs"); const file = "dist/build-info.json"; const information = JSON.parse(fs.readFileSync(file, "utf8")); information.railwayPatchDigest = require("node:crypto").hash("sha256", fs.readFileSync("/tmp/openclaw-plugin-capture.patch")); information.slackRoutingPatchDigest = require("node:crypto").hash("sha256", fs.readFileSync("/tmp/openclaw-slack-routing.patch")); information.slackRoutingContractVersion = 1; fs.writeFileSync(file, JSON.stringify(information));'; \
    OPENCLAW_EXTENSIONS="$selected_plugins" node scripts/prune-docker-plugin-dist.mjs; \
    find dist -name node_modules -prune -exec rm -rf {} +; \
    find dist -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' \) -delete; \
    node --import ./scripts/tsx.mjs --input-type=module -e 'import { writePackageDistInventory } from "./scripts/lib/package-dist-inventory.ts"; await writePackageDistInventory(process.cwd());'

# Compose the six hosted plugins into the root package before the production
# install. The canonical helper owns manifest/inventory cleanup; only its
# validated composition and the lockfile importer additions are retained.
RUN node --import ./scripts/tsx.mjs --input-type=module -e 'import { composeSourceLockfile } from "/tmp/check-slack-routing.ts"; await composeSourceLockfile("/app");'

# Install production dependencies from the patched source lockfile, including
# its security fixes; the released image's node_modules belong to the old lock.
FROM openclaw-build AS openclaw-production
RUN set -eu; \
    rm -rf node_modules ui/node_modules; \
    find packages extensions -name node_modules -prune -exec rm -rf {} +; \
    selected_plugins="$(node -e 'process.stdout.write([...new Set([...require("node:fs").readdirSync("/tmp/release-extensions"), "codex", "acpx", "slack", "lobster", "firecrawl", "exa", "typesafe"])].join(" "))')"; \
    set -- --filter . --filter ./ui --filter './packages/*'; \
    for plugin in $selected_plugins; do set -- "$@" --filter "./extensions/$plugin"; done; \
    NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile --prod "$@" \
      --config.supportedArchitectures.os=linux \
      --config.supportedArchitectures.cpu="$(node -p 'process.arch')" \
      --config.supportedArchitectures.libc=glibc; \
    node scripts/docker/verify-fs-safe-native.mjs --package-root /app --mode require; \
    OPENCLAW_EXTENSIONS="$selected_plugins" node scripts/prune-docker-plugin-dist.mjs; \
    for plugin in acpx slack lobster firecrawl exa typesafe; do \
      rm -rf "dist/extensions/$plugin/node_modules"; \
      mkdir -p "/tmp/$plugin-production-dependencies/node_modules"; \
      mkdir -p "/tmp/$plugin-production-dependencies/node_modules"; \
      cp -a "/tmp/$plugin-production-dependencies/node_modules" "dist/extensions/$plugin/node_modules"; \
      cp "/tmp/$plugin-production-dependencies/package-lock.json" "dist/extensions/$plugin/package-lock.json"; \
    done; \
    node --input-type=module -e 'import { linkSourcePluginDependencies } from "./scripts/lib/bundled-plugin-dependency-links.mjs"; for (const plugin of ["acpx", "slack", "lobster", "firecrawl", "exa", "typesafe"]) linkSourcePluginDependencies("extensions/" + plugin, "dist/node_modules", { includeBin: false });'; \
    mkdir /tmp/runtime-extension-sources; \
    for plugin in $selected_plugins; do cp -a "extensions/$plugin" /tmp/runtime-extension-sources/; done; \
    rm -rf node_modules/openclaw node_modules/.bin/openclaw; \
    node -e 'process.stdout.write(JSON.stringify(require("node:fs").readdirSync("dist", { recursive: true }).toSorted()))' > /tmp/openclaw-build-files.json

# Extend the release with regenerated runtime bundles from the reviewed patch.
# See documentation/UPGRADING.md before changing the release pin.
FROM openclaw-release
COPY --from=runtime-node /usr/local/bin/node /usr/local/bin/node

# Replace generated artifacts instead of overlaying obsolete release bundles.
RUN rm -rf /app/dist /app/node_modules /app/packages /app/extensions

# All runtime bundles and plugin assets come from the same patched source build.
# The Control UI is rebuilt against the same runtime identity; production native
# dependencies are installed from the same patched source lockfile.
COPY --from=openclaw-production --chown=node:node /app/dist/ /app/dist/
COPY --from=openclaw-production --chown=node:node /app/node_modules/ /app/node_modules/
COPY --from=openclaw-production --chown=node:node /app/packages/ /app/packages/
COPY --from=openclaw-production --chown=node:node /tmp/runtime-extension-sources/ /app/extensions/
COPY --from=openclaw-production --chown=node:node /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/
COPY --from=openclaw-production --chown=node:node /tmp/openclaw-build-files.json /app/openclaw-build-files.json
COPY --from=openclaw-build --chown=node:node /app/docker-entrypoint.mjs /app/docker-entrypoint.mjs
COPY --from=openclaw-build --chmod=0644 /tmp/openclaw-slack-routing.patch /etc/openclaw-slack-routing.patch
COPY scripts/check-slack-routing.ts /usr/local/lib/openclaw-railway/check-slack-routing.ts
RUN node /usr/local/lib/openclaw-railway/check-slack-routing.ts runtime /app /etc/openclaw-slack-routing.patch \
 && test "$(node -p 'require("/app/package.json").version')" = "$(node -p 'require("/app/dist/build-info.json").version')"

# Railway mounts volumes owned by root, so the container starts as root only
# long enough for scripts/entrypoint.sh to prepare /data. The entrypoint then
# drops to the image's unprivileged `node` user before OpenClaw runs.
# hadolint ignore=DL3002,DL3066
USER root

# Worker threads resolve SDK imports through the exact packaged host. Install
# the self-link after pruning so directory walks cannot recurse through it.
COPY scripts/check-runtime-workers.ts /usr/local/lib/openclaw-railway/check-runtime-workers.ts
RUN ln -s /app /app/node_modules/openclaw \
 && node /usr/local/lib/openclaw-railway/check-runtime-workers.ts /app

# The Gateway listens on loopback only (gateway.tailscale.mode=serve requires
# it), on 18789. Tailscale Serve, which OpenClaw manages, is the only way in.
# Railway's deploy health check reaches it through the sidecar's relay on 8080,
# the PORT Railway injects when a service sets none.
# OPENCLAW_HOME relocates every OpenClaw path default (state, config, agents,
# credentials, workspace) under the Railway volume: /data/.openclaw.
# OPENCLAW_SUPERVISOR_MODE=external tells OpenClaw that Railway owns the process
# lifecycle, which refuses in-place self-updates and service installs.
ENV OPENCLAW_HOME=/data \
    XDG_CACHE_HOME=/tmp \
    OPENCLAW_DOCKER_ACTIVATION_RECEIPT=/data/.openclaw/railway-image-activation.json \
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
# reads OPENCLAW_MACHINE_DISPLAY_NAME first. The template asks for it, and the
# entrypoint derives the Tailscale machine name from it (tailscale-hostname.mjs);
# without it, both are openclaw.
# Keep this patch in .dockerignore's build-context allowlist.
COPY scripts/patch-machine-display-name.mjs /usr/local/lib/openclaw-railway/patch-machine-display-name.mjs
RUN node /usr/local/lib/openclaw-railway/patch-machine-display-name.mjs

COPY config/openclaw.seed.json /etc/openclaw-railway/openclaw.seed.json
COPY scripts/entrypoint.sh /usr/local/bin/openclaw-railway-entrypoint
COPY scripts/sidecar.mjs scripts/webhook-relay.mjs scripts/tailscale-hostname.mjs /usr/local/lib/openclaw-railway/
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

RUN chmod 0444 /etc/openclaw-railway/openclaw.seed.json /usr/local/lib/openclaw-railway/sidecar.mjs /usr/local/lib/openclaw-railway/webhook-relay.mjs /usr/local/lib/openclaw-railway/tailscale-hostname.mjs \
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
    NPM_CONFIG_CACHE=/tmp/npm \
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
CMD ["node", "openclaw.mjs", "--select-bundled-plugin", "acpx", "--select-bundled-plugin", "slack", "--select-bundled-plugin", "lobster", "--select-bundled-plugin", "firecrawl", "--select-bundled-plugin", "exa", "--select-bundled-plugin", "typesafe", "gateway", "--bind", "loopback", "--tailscale", "serve", "--auth", "token"]
