# Deploy and Host OpenClaw Private Gateway on Railway

OpenClaw Private Gateway runs your own [OpenClaw](https://openclaw.ai) Gateway on Railway, reachable only from your Tailscale tailnet. There is no public domain and no setup web server. The macOS app, the dashboard, and your phone connect to it privately over Tailscale, with HTTPS from your tailnet's certificate.

## About Hosting OpenClaw Private Gateway

This template starts one service with one volume. The **openclaw** service extends a pinned official OpenClaw release with a tested startup performance patch. Tailscale runs inside the same container:

- The Gateway listens only on localhost. OpenClaw itself runs Tailscale Serve, so it appears in your tailnet under the name you give it: `Work Gateway` becomes `https://work-gateway.your-tailnet.ts.net`, and pairing codes and the dashboard origin follow automatically.
- On your tailnet, the dashboard signs you in with your Tailscale identity. Token authentication still protects everything else, and each device that runs the macOS app or a node is approved by hand.
- All state (OpenClaw's config, sessions, and credentials, plus Tailscale's identity and tool logins) lives on a volume at `/data`.

Before you deploy, turn on **MagicDNS** and **HTTPS certificates** in the Tailscale admin console and generate an auth key (not reusable, not ephemeral). The template asks for two values:

| Variable | Value |
| --- | --- |
| `OPENCLAW_MACHINE_DISPLAY_NAME` | a name for this Gateway, such as `Work Gateway`; it is lowercased and hyphenated for the tailnet address |
| `TS_AUTHKEY` | your Tailscale auth key, used once on first boot |

`OPENCLAW_GATEWAY_TOKEN` is generated for you. After deploying, add your model provider, open the dashboard at `https://work-gateway.your-tailnet.ts.net/` (with your Gateway's name), and pair the macOS app. Give each deployment its own name: if your tailnet already has a machine with that name, Tailscale adds a suffix (`work-gateway-1`) and the address follows; the deploy log and the admin console's Machines page show the name it got. The [Quickstart](https://github.com/stevekinney/openclaw-railway-template/blob/main/documentation/QUICKSTART.md) has every command.

## Startup and Restarts

The image puts disposable SQLite inspection snapshots on fast container storage automatically. Full Doctor repair runs when the OpenClaw build or applied patch changes; routine and crash restarts use Gateway state admission with the existing ownership checks. Failed Doctor runs never mark an image activated. Persistent state and the private activation receipt stay on the volume.

The health check uses `/startupz` with a 600-second window. On retained production state, the patched image reached readiness in 6 minutes 37 seconds for first activation and 3 minutes 23 seconds for a routine restart; these are measured examples, not guaranteed startup times. Use `railway restart --service openclaw --yes` to restart the current image without rebuilding. The [upgrade guide](https://github.com/stevekinney/openclaw-railway-template/blob/main/documentation/UPGRADING.md) covers upgrades and restoring backups.

## Common Use Cases

- A personal AI assistant that is always on, reachable from your Mac, phone, and Telegram, and never exposed to the internet.
- Replacing an OpenClaw setup that sat behind a public domain, extra login, or custom proxy.
- Running OpenClaw agents and automations on managed infrastructure instead of a home server.

## Dependencies for OpenClaw Private Gateway Hosting

### Deployment Dependencies

- A Railway account on a paid plan (a service with a volume).
- A Tailscale tailnet with MagicDNS and HTTPS certificates enabled, and an auth key.
- A model provider (for example Anthropic or OpenAI), added after deploy.

### Implementation Details

The service builds from [github.com/stevekinney/openclaw-railway-template](https://github.com/stevekinney/openclaw-railway-template): the official `ghcr.io/openclaw/openclaw` release pinned by digest, the official Tailscale binaries pinned the same way, a small entrypoint that prepares the volume and logs Tailscale in on first boot, and a sidecar that relays only Railway's health check to the loopback-only Gateway. The image also includes optional tools for OpenClaw skills (GitHub CLI, gog for Google Workspace, Claude Code, Codex) and Homebrew on the volume. Upgrades revalidate the patch against the newly pinned source and runtime release. The repository's documentation covers the architecture, security model, upgrades, and troubleshooting.

## Why Deploy OpenClaw Private Gateway on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying OpenClaw Private Gateway on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.

