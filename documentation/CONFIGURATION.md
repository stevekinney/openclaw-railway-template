# Configuration

Where each setting lives, and why. Nothing here is a secret except where noted.
Secrets go in Railway variables (sealed), never in this repository.

For a copyable list of the runtime variables, see [`.env.example`](../.env.example).

## Build time (baked into the image)

| Setting | Where | Value |
| --- | --- | --- |
| OpenClaw version | `Dockerfile` `FROM` line | `ghcr.io/openclaw/openclaw:2026.10.3@sha256:70b8…` — the only version pin |
| `HOME` | `scripts/as-node.sh` | `/data/home`, on the volume, for the Gateway and `as-node` commands, so tool logins and settings under `~` persist. A root shell's `HOME` is `/root`. See [TOOLS.md](TOOLS.md). |
| Skill tools | `Dockerfile`, `tools/package.json` | `gog`, `claude`, `codex`, `jq`, `tmux`, ImageMagick as a pinned baseline; see [TOOLS.md](TOOLS.md). |
| Homebrew | `Dockerfile` (seed), `/data/linuxbrew` | Homebrew 7.0.9 seeded onto the volume on first boot, then self-updating. `/home/linuxbrew/.linuxbrew` is a symlink to it. |
| `PATH`, `NPM_CONFIG_PREFIX` | `scripts/as-node.sh` | For the Gateway and `as-node` commands: `openclaw`/`brew` wrappers, then `~/.local/bin`, then Homebrew, then the image; `npm install -g` writes to `~/.local` on the volume. A root shell's `PATH` (the `Dockerfile`'s) has no directory on the volume. |
| GitHub CLI | `Dockerfile` `RUN` step | `gh` 2.102.0, checksum-verified. Needed for **Settings → Profile → GitHub connections**; OpenClaw stores each connection under `/data/.openclaw/credentials/github/`, so connections persist. |
| Tailscale version | `Dockerfile` `FROM … AS tailscale` line | `tailscale/tailscale:v1.104.1@sha256:87c5…`; only the `tailscale` and `tailscaled` binaries are copied in |
| `OPENCLAW_HOME` | `Dockerfile` | `/data` → state at `/data/.openclaw` |
| `OPENCLAW_GATEWAY_PORT` | `Dockerfile` | `18789`, on loopback only |
| `OPENCLAW_SUPERVISOR_MODE` | `Dockerfile` | `external` — Railway owns the process lifecycle; OpenClaw refuses self-update and service installs, and restarts by exiting cleanly |
| `OPENCLAW_NO_AUTO_UPDATE` | `Dockerfile` | `1` |
| Gateway bind, Tailscale mode, auth mode | `Dockerfile` `CMD` | `gateway --bind loopback --tailscale serve --auth token` (pinned so no config edit can undo them) |
| Baseline OpenClaw config | `config/openclaw.seed.json` | Copied to `/data/.openclaw/openclaw.json` on first boot only |
| Tailscale settings | `Dockerfile` | `TS_STATE_DIR=/data/tailscale` (node key and certificates, on the volume), `TS_SOCKET=/var/run/tailscale/tailscaled.sock` (the CLI's default, so `tailscale` and OpenClaw need no flags), `TS_DEBUG_MTU=1236` (fits Railway's 1316-byte network MTU). The machine name (`TS_HOSTNAME`) is derived by the entrypoint; see below |
| Tailscale and health relay | `scripts/sidecar.mjs` | Runs `tailscaled` in userspace mode as `node`; stops the container if it exits. Relays only `/healthz`, `/readyz`, and `/startupz` from `PORT` to the loopback Gateway |
| Tailscale Serve | OpenClaw (`gateway.tailscale.mode: "serve"`) | HTTPS on the node's MagicDNS name → a private loopback listener owned by the Gateway. No Serve config in this repository |

The Dockerfile declares no `ARG`s. Railway passes service variables to builds
only as matching build arguments, so no variable can reach an image layer
(`tests/image.test.sh` checks this).

There is no `PORT` variable. Railway injects `PORT=8080` into any service that
doesn't set one, and the sidecar's health relay listens there. The Gateway
itself listens on `127.0.0.1:18789`, which nothing outside the container can
reach. The entrypoint refuses to start if `PORT` is `18789`.

## Railway variables: `openclaw` service

| Variable | Required | Secret | Purpose |
| --- | --- | --- | --- |
| `OPENCLAW_GATEWAY_TOKEN` | yes | **yes** | Gateway authentication secret, ≥ 32 characters, for clients that don't sign in with their tailnet identity (the Mac app, the CLI, the HTTP API). Generate with `openssl rand -hex 32`; the Railway template generates it. |
| `TS_AUTHKEY` | on first boot | **yes** | Tailscale auth key. Used once: on first boot, or after the machine was removed from the tailnet. Afterwards the node key on the volume logs in and this is never read. The entrypoint passes it to `tailscale up` in a file, then removes it from the environment before the Gateway starts. See [TAILSCALE.md](TAILSCALE.md). |
| `TS_HOSTNAME` | no | no | The machine name (the Tailscale DNS label). Overrides the one derived from the display name, `OPENCLAW_MACHINE_DISPLAY_NAME`. Made into a DNS label the same way. Takes effect on the next login. |
| Provider key, e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` | for the provider you choose | **yes** | Model credential. Onboarding stores an env reference to it, not the value. |
| `OPENCLAW_MACHINE_DISPLAY_NAME` | asked by the template | no | The display name: the Gateway's name, shown as typed in OpenClaw's machine picker (without the image's patch OpenClaw would show Railway's per-deploy container hostname). At first login it also names the Tailscale machine, and so the address; the derived machine name is: lowercased, accents dropped, and every other run of characters outside a–z and 0–9 turned into one hyphen, cut to 63 characters (`My Gateway` → `my-gateway`, `Café Bot!` → `cafe-bot`). A name with no letters or digits is refused at login; set `TS_HOSTNAME` then. Unset: both are `openclaw`. Changing it later changes the picker name only; rename the machine in the Tailscale admin console. |
| `GOG_KEYRING_PASSWORD` | for the gog skill | **yes** | Password for `gog`'s token file on the volume. Required for the Gmail watcher, which runs non-interactively. See [TOOLS.md](TOOLS.md#google-gog). |
| `OPENCLAW_RAILWAY_WEBHOOKS` | no | no | `on` serves the webhook routes (`POST /hooks/<name>`, `POST /gmail-pubsub`) on `PORT`. Public only with a Railway domain. See [WEBHOOKS.md](WEBHOOKS.md). |
| `OPENCLAW_HOOKS_TOKEN` | for webhooks | **yes** | Hooks token. `hooks.token` references it as `${OPENCLAW_HOOKS_TOKEN}`, and the relay checks it before forwarding. Use a token dedicated to hooks. |
| `OPENCLAW_GMAIL_PUSH_TOKEN` | for Gmail push | **yes** | Token in the Pub/Sub push URL; `hooks.gmail.pushToken` references it. |
| `TELEGRAM_BOT_TOKEN` | for Telegram | **yes** | Bot token from @BotFather. Its presence enables Telegram (DM pairing, allowlisted groups). |
| `OPENCLAW_RAILWAY_GMAIL_WATCH_PORT` | no | no | Loopback port of OpenClaw's Gmail watcher, where the webhook relay forwards `POST /gmail-pubsub`. Default `8788`. Only used with `OPENCLAW_RAILWAY_WEBHOOKS=on`. |
| `GOG_LOGIN_HTTPS_PORT` | no | no | The tailnet HTTPS port `gog-login` uses for Google's temporary OAuth callback. Default `8443`; the access policy must allow it ([TAILSCALE.md](TAILSCALE.md)). Read by `gog-login` (`scripts/gog-login.sh`) when it runs; set it as a service variable or in front of the command. |
| `GOG_LOGIN_LISTEN_PORT` | no | no | The loopback port `gog` listens on during `gog-login`; Serve forwards the callback to it. Default `8085`. Read the same way as `GOG_LOGIN_HTTPS_PORT`. |

### Variables for `.railway/railway.ts` (not set on the service)

These are read by the Railway CLI when it evaluates `.railway/railway.ts`
(`railway config plan` and `apply`), in your shell, not by the container. Only
`OPENCLAW_RAILWAY_REPOSITORY` has no usable default.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENCLAW_RAILWAY_REPOSITORY` | none (the plan fails without it) | Your fork, as `owner/repository`. Or edit `sourceRepository` in the file. |
| `OPENCLAW_RAILWAY_BRANCH` | `main` | The branch Railway builds. |
| `OPENCLAW_RAILWAY_REGION` | `us-west2` | Region of the service and its volume. Choose it before the first apply; see [DEPLOYMENT.md](DEPLOYMENT.md#1-create-the-railway-project). |

Every variable on the service managed by `.railway/railway.ts` must also appear in
that file — secrets as `preserve()` — or `railway config plan` will propose
deleting it. See [DEPLOYMENT.md](DEPLOYMENT.md#keeping-variables-in-sync).

## How environment variables and `openclaw.json` interact

- OpenClaw reads `/data/.openclaw/openclaw.json`. Not every setting has an
  environment variable; use the config file (`openclaw config set …`) for
  everything not listed above.
- Process environment wins over `$OPENCLAW_STATE_DIR/.env` and the config `env`
  block. Railway variables are process environment.
- The baseline config refers to the Gateway token as an env SecretRef
  (`{ "source": "env", "provider": "default", "id": "OPENCLAW_GATEWAY_TOKEN" }`).
  If the variable is missing, auth fails closed; there is no fallback.
- Onboarding with `--secret-input-mode ref` stores provider keys the same way.
  Verified for this template: after onboarding with `ANTHROPIC_API_KEY` and
  adding Telegram with `--use-env`, neither secret value appears anywhere under
  `/data/.openclaw`. A provider key entered in the dashboard (**Connect
  provider**) is not a reference: OpenClaw writes the value to the agent's auth
  profile in SQLite on the volume. The dashboard's code path stores
  `{ type: "api_key", provider, key }`, with no `keyRef`.
- Command-line flags beat config: the `CMD` pins
  `--bind loopback --tailscale serve --auth token`, so onboarding or a config
  edit cannot expose the Gateway differently or make it unauthenticated. The
  config file says the same (the baseline config sets `gateway.bind:
  "loopback"` and `gateway.tailscale.mode: "serve"`), because separate CLI
  commands such as `openclaw qr` read the file, not the flags. The entrypoint
  refuses a config from the previous two-service layout; see
  [UPGRADING.md](UPGRADING.md#migrating-from-the-two-service-layout).

## What lives on the volume

`OPENCLAW_HOME=/data` relocates every OpenClaw path default, so all durable state
is under `/data/.openclaw` (observed layout after onboarding):

```text
/data/.openclaw/
├── openclaw.json (+ .bak, .last-good)  Gateway, channel, agent, and tool config
├── state/openclaw.sqlite               shared state: device pairing, secrets store, provider auth
├── agents/<agentId>/                   per-agent SQLite (sessions, auth profiles), agent identity
├── workspace/                          default agent workspace: memory files, AGENTS.md, SOUL.md, …
├── plugin-skills/, media/, cache/      installed skills, media, caches
└── tmp/, migration/                    OpenClaw-managed working files
```

OAuth tokens (for OAuth-based providers) are stored in SQLite on this volume in
plaintext. Treat the volume and its backups as credentials.

The Gateway's `HOME` is `/data/home` and Homebrew is `/data/linuxbrew`, both on the volume, so
command-line tools keep their logins, settings, and updates across redeploys.
Tailscale's state (node key, certificates) is `/data/tailscale`, so the machine
keeps its name and address across redeploys. Not persisted: `/tmp`, including
OpenClaw's rolling file log (`/tmp/openclaw/openclaw-<date>.log`; the same
output goes to stdout and Railway's logs).

## Don't set a Start Command

Leave Railway's **Start Command** empty. The image's `CMD` is the stock
foreground Gateway invocation, which OpenClaw's entrypoint recognizes and runs
Doctor migrations before. A different command (even `openclaw gateway`, which
resolves to the CLI wrapper) skips Doctor. The one sanctioned override is
`sleep infinity` for [maintenance](TROUBLESHOOTING.md#exit-code-78).
