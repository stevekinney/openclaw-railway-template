# Security

There are two separate questions:

1. **Infrastructure security**: who can reach the Gateway, and what does the
   container run with? This template answers it, and the image tests check it.
2. **Agent-level authorization**: what can the agent do once a message reaches
   it, and who may send it messages? That is OpenClaw configuration, and it is
   your call. Recommended starting points are below.

A perfectly private Gateway can still be talked into running a harmful command
by a web page or email it reads. Infrastructure controls don't protect against
that; agent policy does.

## Infrastructure controls

| Control | How | Evidence |
| --- | --- | --- |
| No public exposure | No Railway domain or TCP proxy; OpenClaw runs Tailscale Serve (tailnet only), never Funnel. | `tests/railway-config.test.ts` |
| Tailnet-only access | The Gateway listens only on loopback (`127.0.0.1:18789`); the only way in is OpenClaw-managed Tailscale Serve. Nothing on Railway's private network can reach it; the health relay on 8080 answers only `/healthz`, `/readyz`, `/startupz`. Tailnet policy limits who reaches the node. | `tests/image.test.sh` (Gateway port unreachable from the network; relay 404 matrix) |
| Gateway authentication | `--auth token` pinned in `CMD`; token ≥ 32 chars enforced by the entrypoint; failed-auth rate limiting in the seed. Tailnet identity can replace the token for the Control UI only ([below](#tailnet-identity-sign-in)). | `tests/image.test.sh` (401 without/with a wrong token) |
| No proxy-trust shortcuts | `gateway.trustedProxies` empty; no `allowRealIpFallback`, no Host-header origin fallback, no `auth.mode: none`. Forwarded or Tailscale headers sent to the ordinary listener are rejected even with the token; Tailscale identity counts only on OpenClaw's managed Serve listener, verified with `tailscale whois`. | `tests/image.test.sh` (403 with `X-Forwarded-For` or `Tailscale-User-Login` on loopback) |
| No auto-trusted nodes | Node-role connections (Mac app node, node hosts, phones) must be approved; SSH-verified node auto-approval disabled; no `autoApproveCidrs`. | Live-verified pairing; no automated remote test (there is no remote-reachable listener to test from) |
| Least privilege | The Gateway, `tailscaled`, the sidecar, and all their children run as uid 1000; root is used only by the entrypoint to prepare the volume and log Tailscale in, then dropped with `setpriv`. No added Linux capabilities (userspace networking, no TUN). The operator terminal (host shell) is off. | `tests/image.test.sh` (every process uid 1000) |
| Secrets stay out of images and the repo | The Dockerfile declares no `ARG`; secrets are Railway variables (seal them); config refers to them as env SecretRefs; onboarding stores references, not values. | `tests/image.test.sh` (environment and history scans); manual check that no secret value appears under `/data/.openclaw` |
| Secrets stay out of logs, `ps`, and the agent | The entrypoint never prints the token or the Tailscale auth key; neither is a command-line argument (the key goes to `tailscale up` through a mode-600 file that is deleted). `TS_AUTHKEY` is unset before the Gateway starts, and the sidecar starts without it or the Gateway token. | `tests/image.test.sh` (token absent from process arguments; rejected key absent from output; live tier: key absent from the Gateway's environment, files, and logs) |
| No self-update | `OPENCLAW_SUPERVISOR_MODE=external` and `OPENCLAW_NO_AUTO_UPDATE=1`; upgrades only by image change. | [UPGRADING.md](UPGRADING.md) |

Known trade-offs:

- `tailscaled` runs in the Gateway's container, as the same user. Anything that
  can run code as `node` (including the agent's shell) can use the local
  Tailscale daemon, for example `tailscale status` or `tailscale serve`. It
  already could read the Gateway token and state; keep exec policy tight
  ([below](#shell-execution)).
- In userspace mode `tailscaled` listens on `0.0.0.0:<random>` TCP for
  Tailscale's peer API. It rejects anything that isn't an authenticated tailnet
  peer (`peerapi: unknown peer`). The previous separate Tailscale container had
  the same listener.
- The sidecar's health relay listens on 8080 on Railway's private network. It
  forwards only the three unauthenticated probe paths (`GET`/`HEAD`); other
  services in the project can see whether the Gateway is up, nothing more.
- The volume holds OAuth tokens (plaintext SQLite), pairing records,
  conversation history, and the Tailscale node key. Railway volume backups
  contain the same. Limit who has access to the Railway project; project members
  can also `railway ssh` in as root.

## Tailnet identity sign-in

With `gateway.tailscale.mode: serve`, `gateway.auth.allowTailscale` defaults to
`true`. A browser that opens `https://<machine-name>.<tailnet>.ts.net/` signs in to the
Control UI with its Tailscale identity: no token and no device approval
(verified; no pairing record is created). Only the Control UI WebSocket and
avatar reads accept it; HTTP API endpoints (`/v1/*`, `/tools/invoke`, …) always
require the token, and node-role connections still need pairing approval.

What it means:

- **Your tailnet access policy decides who can sign in.** Anyone whose device
  the policy lets reach the node on port 443 gets an operator session. OpenClaw
  has no per-person allowlist for this. On a personal tailnet that is you; on a
  shared tailnet, restrict access to the node with a tag and a grant
  ([TAILSCALE.md](TAILSCALE.md#1-prepare-the-tailnet)).
- **OpenClaw's docs say the tokenless flow assumes a trusted host.** Here the
  agent can run commands on that host, so a prompt-injected agent could forge
  identity headers on the loopback listener. That isn't a new hole: the agent
  runs as the same user as the Gateway and can already read the token and state.
- To require the token in the browser too:

  ```bash
  railway ssh --service openclaw -- openclaw config set gateway.auth.allowTailscale false
  ```

## Security audit

Run after onboarding, after any config change, and after every upgrade:

```bash
railway ssh --service openclaw -- openclaw security audit --deep
```

Expected result on a correctly deployed template (checked in
`tests/image.test.sh`, deep probe checked manually):

- **0 critical and 1 warning** from a fresh deployment:
  `gateway.trusted_proxies_missing` ("Reverse proxy headers are not trusted").
  It fires for every loopback Gateway with an empty `gateway.trustedProxies`,
  including OpenClaw's own recommended Serve setup. Managed Serve doesn't use
  `trustedProxies`, and the suggested fix (trusting `127.0.0.1`) would let every
  process in the container claim to be a proxy. Leave it.
- **With `--deep`**: adds `gateway.probe_failed`, because the deep probe
  connects without a device identity (also on the unmodified official image;
  re-checked 2026-10-08). It also scans installed extension code: on the
  production deployment it flagged the `acpx` extension (`plugins.code_safety`,
  "Shell command execution detected"), which launches coding agents by design.
  Findings about plugins you installed are yours to review; the template adds
  none. The `acpx` finding was reviewed on 2026-10-13: the plugin is
  `@openclaw/acpx` from ClawHub's official channel (`openclaw plugins inspect
  acpx` shows the source, trust, and integrity), and the flagged line is
  `spawn()` of the configured agent command, without a shell, in its MCP proxy.
  To keep the finding from masking new ones, suppress only that file and record
  why, rather than the whole check:

  ```bash
  openclaw config set security.audit.suppressions '[{"checkId":"plugins.code_safety","titleIncludes":"\"acpx\"","detailIncludes":"dist/mcp-proxy.mjs","reason":"Official @openclaw/acpx; spawns the configured ACP agent without a shell. Reviewed 2026-10-13."}]' --strict-json
  ```

  Review it again after updating the plugin.
- **With webhooks on and a restricted reader** ([WEBHOOKS.md](WEBHOOKS.md)): no
  new findings, provided `hooks.allowRequestSessionKey` stays `false`,
  `hooks.defaultSessionKey` is set, and cross-agent session access is off
  (`tools.sessions.visibility: agent`, `tools.agentToAgent.enabled: false`).
  OpenClaw's own Gmail reader example enables caller-chosen session keys, which
  the audit rates critical; the template's version doesn't.

Other useful forms: `openclaw security audit --json` for automation, and
`openclaw security audit --fix` for OpenClaw's narrow safe fixes (file
permissions and open group policies). Triage order and the full check catalog
are in [OpenClaw's audit docs](https://docs.openclaw.ai/gateway/security/running-the-audit).

## Recommended agent policy

A starting point for a personal assistant that reads untrusted content such as
the web, email, and documents. Every key was validated against 2026.9.8 with
`openclaw config set`:

```bash
railway ssh --service openclaw -- openclaw config set --batch-json '[
  {"path":"tools.exec.mode","value":"ask"},
  {"path":"tools.exec.strictInlineEval","value":true},
  {"path":"tools.elevated.enabled","value":false},
  {"path":"tools.agentToAgent.enabled","value":false},
  {"path":"session.dmScope","value":"per-channel-peer"},
  {"path":"browser.enabled","value":false},
  {"path":"gateway.nodes.browser.mode","value":"off"}
]'
railway redeploy --service openclaw --yes   # browser.enabled needs a restart
```

### Shell execution

By default (`tools.exec.mode` unset), the agent may run any shell command in the
Gateway container. There, a command can read the state volume (OAuth tokens,
pairing database, history) and the process environment (provider keys,
`OPENCLAW_GATEWAY_TOKEN`). OpenClaw's tool sandbox needs a Docker or Podman
daemon, which a Railway container doesn't have, so **exec policy is the main
boundary here**:

- `tools.exec.mode: "ask"` runs allowlisted commands and asks you to approve the
  rest (in the Mac app, the dashboard, or Telegram for the command owner).
  `"deny"` blocks host exec entirely; `"full"` is OpenClaw's trusted-operator
  default.
- `tools.exec.strictInlineEval: true` makes `python -c`, `node -e`, and similar
  forms always need approval.
- Keep `tools.elevated.enabled: false`.

### Browser automation

The default image has no Chromium, and browser control acts with whatever
sessions the browser profile holds. Keep `browser.enabled: false` and
`gateway.nodes.browser.mode: "off"` unless you need it. If you do, use the
`-browser` image variant with a dedicated profile, and treat downloads and
page content as untrusted.

### Telegram

Defaults when `TELEGRAM_BOT_TOKEN` is set: `dmPolicy: "pairing"`,
`groupPolicy: "allowlist"` with no groups allowed. For a one-owner bot:

```bash
railway ssh --service openclaw -- openclaw config set channels.telegram.allowFrom '["<your-numeric-user-id>"]'
railway ssh --service openclaw -- openclaw config set channels.telegram.dmPolicy allowlist
# Optional, per group you add the bot to (negative chat ID):
railway ssh --service openclaw -- openclaw config set channels.telegram.groups '{"<group-chat-id>":{"requireMention":true}}'
```

Never use `dmPolicy: "open"` with `allowFrom: ["*"]` on a bot with tools: anyone
who finds the bot's username can command it. Pairing approval grants DM access
only, and the first approved pairing becomes the command owner
(`commands.ownerAllowFrom`), who can approve exec requests and change config.

### Local node permissions (the Mac)

A paired Mac node lets the Gateway invoke commands on your Mac, including
`system.run`, which is remote code execution there. Control it on the Mac in
**Settings → Exec approvals** (security, ask, allowlist). To forbid remote shell
on every node from the Gateway side:

```bash
railway ssh --service openclaw -- openclaw config set gateway.nodes.commands.deny '["system.run"]'
```

Approve node capability requests (`openclaw nodes pending`) deliberately; they
widen what the agent can do on that device.

### Tools in the image

The image includes `gh`, `gog`, `claude`, `codex`, `jq`, and `tmux` so bundled
skills work ([TOOLS.md](TOOLS.md)). Once you log one in, the agent can use it
with that account: `gog` reaches your mailbox, calendar, and Drive; `gh` and the
coding agents can push code. The agent can also install and update software on
the volume with `brew` and `npm install -g`; those installs persist and aren't
pinned or reviewed. All of this makes prompt injection more consequential.

ImageMagick parses images that anyone who can message the agent sends, but
only formats OpenClaw's built-in decoder can't read (such as HEIC). Debian's
default ImageMagick policy blocks the riskiest decoders (PostScript, PDF, XPS,
URL fetches). Debian security fixes reach the image when it is rebuilt, so
redeploy periodically even without an OpenClaw upgrade.
Keep `tools.exec.mode: "ask"` for agents that read untrusted content, log in
only the tools you use, and prefer narrowly scoped credentials (for example, only
the Google services you need).

### Prompt injection

Anything the agent reads can carry instructions: web pages, search results,
emails, documents, attachments, pasted logs. Allowlisting senders doesn't help
against content.

- Use a current, top-tier model for any agent with tools. OpenClaw's own
  guidance is explicit that smaller and older models are much easier to steer.
- Keep `exec` on `ask` (above) for agents that read untrusted content, or route
  that content through a separate reader agent with no tools.
- Keep the hook bypass flags (`allowUnsafeExternalContent`) off.
- Don't put secrets in prompts, workspace files, or memory; they belong in
  Railway variables.

See [OpenClaw's prompt-injection guidance](https://docs.openclaw.ai/gateway/security/prompt-injection).

## Public webhooks

Off by default. When you turn them on ([WEBHOOKS.md](WEBHOOKS.md)), the service
gets a public Railway domain that answers only the three health checks and two
`POST` routes; the dashboard, WebSocket, and HTTP API stay on the tailnet. Hook
requests need the hooks token, checked by the relay before anything reaches the
Gateway; Gmail pushes need their own push token, checked by OpenClaw's watcher.
Repeated failures lock the caller out. Webhook and email content is untrusted:
route it to a restricted agent (the template's `mail_reader` has no file, shell,
web, or browser tools) and keep it out of `main`'s sessions.

## Rotating credentials

| Credential | Rotate by | Notes |
| --- | --- | --- |
| Gateway token | Set a new `OPENCLAW_GATEWAY_TOKEN` ([Rotate the token](DEPLOYMENT.md#rotate-the-token); Railway redeploys), then update each client, including the Mac app's Keychain item. | Paired devices also hold per-device tokens that a shared-token rotation does not revoke. To cut a device off, `openclaw devices revoke --device <id> --role <role>`. |
| Provider key | Set the new value on the Railway variable; revoke the old key at the provider. | Onboarding stored a reference, so no OpenClaw change is needed. A key added in the dashboard (Connect provider) is stored on the volume instead; replace it there. |
| Telegram bot token | `/revoke` in @BotFather, set the new `TELEGRAM_BOT_TOKEN`. | |
| Tailscale node | [TAILSCALE.md](TAILSCALE.md#operations) | `TS_AUTHKEY` is used only on first login; rotating it changes nothing until the node is logged out. |

## If something is compromised

1. Remove the Gateway's machine from the tailnet (admin console) to cut all
   access immediately.
2. Rotate the Gateway token and revoke every paired device:
   `openclaw devices list`, then `openclaw devices revoke …`.
3. Rotate provider keys and the Telegram bot token.
4. Review `openclaw security audit --deep` and recent sessions before re-adding
   the node. Removing the machine logs the container out, so it needs a new
   `TS_AUTHKEY` to rejoin; until then it refuses to start.
