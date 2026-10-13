# Acceptance criteria

Status as of 2026-10-08. Statuses:

- **Verified**: checked by a repeatable test or command, cited.
- **Verified (previous layout)**: verified live while Tailscale ran as a separate
  Railway service; not yet repeated with Tailscale in the `openclaw` container.
- **Live validation required**: depends on a real Railway project, tailnet,
  Mac app, or Telegram bot, not yet exercised with the current layout. The
  evidence that exists is listed.
- **Failed**: none.

## Deviation from the brief: Tailscale in the Gateway's container

The original brief asked for "Tailscale private access via a separate service".
On 2026-10-08 the owner approved replacing that with `tailscaled` inside the
`openclaw` container and OpenClaw-managed Serve (`gateway.tailscale.mode: serve`,
loopback-only Gateway). Reasons: OpenClaw's supported setup, a template that
asks only for a Tailscale auth key (no hand-entered tailnet address, no
`openclaw-1` mismatch), tailnet identity sign-in, and a Gateway nothing else in
the Railway project can reach. Costs: a second long-running process and a
probe-only health relay in `scripts/sidecar.mjs`, and one audit warning
(`gateway.trusted_proxies_missing`, see
[SECURITY.md](SECURITY.md#security-audit)). Design: [ARCHITECTURE.md](ARCHITECTURE.md).

## Local tests

- `sh tests/image.test.sh`: core tier, **88 checks** in a full run, no tailnet
  needed. It covers the relay's 404 matrix and the Gateway port being
  unreachable from the network, loopback authentication and proxy attribution,
  the webhook routes (token in header or path, refusals, 413, per-caller
  lockout, off unless opted in), the entrypoint's refusals (missing or rejected
  auth key, old-layout config, `PORT` collision, `hooks.gmail.tailscale.mode`),
  the `tailscaled` watchdog, persistence, ownership repair, and crash handling.
- The same script's **live tier** runs when `TAILSCALE_TEST_AUTHKEY` is set (a
  reusable, ephemeral key): real login, Serve URL, QR address, key hygiene,
  restart reuse, watchdog, the logged tailnet address (on every boot, and the name Tailscale assigned when a second machine asks for a taken hostname in capitals), and, with `TAILSCALE_TEST_ON_TAILNET=1`, the
  dashboard over the tailnet and `gog-login`'s callback route: 17 checks. All
  105 passed on 2026-10-08. CI passes the key from an optional repository
  secret.
- `npm run test:railway-config` (5 tests), `npm run typecheck`, ShellCheck,
  Hadolint, and actionlint.

Remote-peer device-pairing tests were removed with the layout change: there is
no remote-reachable listener to test from. Node pairing over Serve is a live
check.

**Prototype on a real tailnet (2026-10-08, local Docker).** The in-container
layout joined a real tailnet as `openclaw-proto`, with a Mac on the tailnet as
the client:

- OpenClaw logged `serve enabled: https://openclaw-proto.<tailnet>.ts.net/` and
  answered `/healthz`, `/startupz`, `/readyz` with 200 over HTTPS from the Mac.
  The first HTTPS request took ≈15.6 s (certificate issuance), later ≈16 ms.
- The dashboard opened in a browser with tailnet identity sign-in: no token, no
  device approval, no pairing record created.
- `openclaw qr --json`: `wss://openclaw-proto.<tailnet>.ts.net`, access
  `full`, URL source `gateway.tailscale.mode=serve`.
- Restart reused the saved login (no key) and Serve came back; killing
  `tailscaled` stopped the container in ≈2 s with a clean Gateway shutdown.
- `TS_AUTHKEY` was absent from the Gateway's environment and from the logs.
- Listeners: Gateway and Serve's listener on loopback, the relay on 8080, and
  `tailscaled`'s peer API on `0.0.0.0:<random>` (rejects non-tailnet peers).
- Security audit: 0 critical, 1 warning (`gateway.trusted_proxies_missing`).

Not covered by the prototype: Railway's network (the MTU fix), Railway's deploy
health check through the relay, and the Mac app.

## Criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | OpenClaw is explicitly pinned | Verified | `Dockerfile` `FROM ghcr.io/openclaw/openclaw:2026.9.8@sha256:d0de…`; test "installed OpenClaw (2026.9.8) matches the Dockerfile pin". Pinned to **2026.9.8**, not the brief's 2026.9.7, at the owner's direction (2026.9.8 is the current `latest`, a reliability-only hotfix). Tailscale is pinned the same way (`FROM tailscale/tailscale:v1.102.5@sha256:… AS tailscale`), with its own version test. |
| 2 | The Gateway is the primary application process | Verified | Process tree: `tini` (PID 1) → `openclaw-gateway`; the entrypoint `exec`s away. The sidecar and `tailscaled` run beside it, all uid 1000. Tests "tini is PID 1", "every container process runs as uid 1000". |
| 3 | No custom setup HTTP server | Verified | No setup or onboarding server; onboarding is OpenClaw's own CLI ([DEPLOYMENT.md](DEPLOYMENT.md)). The sidecar's relay serves only the three probe paths (tested). |
| 4 | No unnecessary reverse proxy | Verified | Tailnet traffic goes through OpenClaw's own managed Serve. The relay is necessary because Railway's health check can't reach a loopback-only Gateway; it forwards only `GET`/`HEAD` of `/healthz`, `/readyz`, `/startupz` (404 matrix tested). |
| 5 | No custom process supervisor | Verified (with one exception) | Upstream `tini` is PID 1 and Railway owns restarts; external-supervisor mode exits 0 for restarts. The sidecar only stops the container when `tailscaled` exits, so Railway restarts both (tested). |
| 6 | Railway manages container restarts | Verified (previous layout) | Live: after onboarding changed `gateway.port`, the Gateway exited cleanly ("full process restart (supervisor restart)") and Railway restarted it. Config: `restartPolicyType: "ALWAYS"`. Crash restart and the `tailscaled` watchdog verified locally. |
| 7 | Persistent configuration survives redeployment | Verified (previous layout) | Live: state on the `openclaw-state` volume survived a redeploy and a volume migration; the baseline config was not rewritten. Locally: config, `HOME`, Homebrew, and Tailscale state survive restarts (tested). |
| 8 | Gateway authentication is enforced | Verified | `--auth token` pinned; 401 without or with a wrong token on the loopback listener; entrypoint refuses missing or short tokens. Tailnet identity replaces the token only for the Control UI through managed Serve ([SECURITY.md](SECURITY.md#tailnet-identity-sign-in)). |
| 9 | The Gateway is not publicly exposed by default | Verified | `.railway/railway.ts` declares no domains or TCP proxies (tested); the Gateway is loopback-only and its port is unreachable from the network (tested); `CMD` pins `--tailscale serve`, never Funnel. Fresh template deploy (2026-10-08, `48ba023`): the service had no service or custom domains (API query). |
| 10 | Tailscale provides authenticated private access | Verified (Railway scratch deploy) | 2026-10-08, scratch Railway project built from the `tailscale-in-gateway` branch: the container logged in with `TS_AUTHKEY`, OpenClaw enabled Serve at `https://openclaw-railway-test.<tailnet>.ts.net/`, reachable from a tailnet Mac (TLS ≈0.14 s, 300–950 KB/s), QR `wss://…` with full access, audit 0 critical / 1 expected warning. |
| 11 | Tailscale configuration survives restarts | Verified (prototype) | Restart reused the saved login without `TS_AUTHKEY`; Serve came back (live tier check). |
| 12 | Proxy attribution is handled securely | Verified | Ordinary listener: token → 200; forwarded or `Tailscale-User-Login` headers → 403 "Proxy client attribution is required", even with the token (tested). Tailscale identity counts only on OpenClaw's managed Serve listener, checked with `tailscale whois`. `trustedProxies` stays empty. [ARCHITECTURE.md](ARCHITECTURE.md#why-the-proxy-attribution-error-cannot-recur) |
| 13 | The macOS desktop app can connect | Verified (live) | Previous layout: `openclaw-mac primary set --direct-url wss://openclaw.<tailnet>.ts.net --token-stdin`, paired, `connected`. Production migration to the one-service layout (2026-10-08): the app reconnected on its own to the same `wss://openclaw.<tailnet>.ts.net` (`connected`, Gateway 2026.9.8), and again after a later restart. |
| 14 | Desktop device pairing works | Verified (live) | Previous layout: separate operator and node pairing requests stayed pending until `openclaw devices approve`, then connected. Migration: all 7 paired devices kept, 0 pending, and the Mac reconnected without re-approval. New device on the current layout (2026-10-08): a node host on a tailnet Mac connected to `wss://openclaw.<tailnet>.ts.net`, stayed pending ("device pairing required"), connected after `openclaw devices approve`, and was removed afterwards. Mac app on a fresh template deploy (2026-10-08): `openclaw-mac gateway add` returned `disconnected`, the request appeared under **Settings → Devices → Pending approval**, **Approve** in the dashboard, then `openclaw-mac gateway reconnect` → `connected` (operator; no node request for a non-primary gateway). Browser operator sessions sign in with tailnet identity (verified live). |
| 15 | Telegram integration works | Verified (live) | Production (2026-10-08): `openclaw channels status --probe` reports Telegram enabled, connected, polling as the configured bot, probe `works`, after the migration. Token handling was tested with a dummy token: `TELEGRAM_BOT_TOKEN` enables Telegram with `dmPolicy: pairing` / `groupPolicy: allowlist` and never lands on the volume. |
| 16 | Railway health checks reflect actual Gateway availability | Verified | `/startupz` through the relay from another container, including the `healthcheck.railway.app` Host header (tested). `/startupz` turns 200 only after Serve is claimed. On Railway (scratch deploy, 2026-10-08), the deploy reached `SUCCESS` through the relay. |
| 17 | Security auditing is documented | Verified (prototype) | [SECURITY.md](SECURITY.md#security-audit). Fresh deployment: 0 critical, 1 warning `gateway.trusted_proxies_missing` (tested; generic for loopback Gateways, left on purpose). `--deep` not yet re-checked. |
| 18 | Docker builds are reproducible | Verified | Base images and BuildKit frontend pinned by digest; release binaries checksum-verified; npm lockfiles; GitHub Actions pinned to commit SHAs. Debian packages (`jq`, `tmux`, ImageMagick) are deliberately unpinned ([UPGRADING.md](UPGRADING.md)). |
| 19 | Version upgrades require one authoritative version change | Verified | One `FROM` line per upstream (OpenClaw, Tailscale); tests derive the expected versions from them. Dependabot updates tag and digest together. |
| 20 | CI validates the deployment configuration | Verified | `.github/workflows/ci.yml` (static checks and the image test) has passed on every push to `main`. The live tier runs in CI only when the `TAILSCALE_TEST_AUTHKEY` secret is set. |
| 21 | Backup and rollback procedures are documented | Verified (docs) / restore live pending | [UPGRADING.md](UPGRADING.md). `openclaw backup create --verify` tested against a running Gateway. Railway backup restore not exercised. |
| 22 | The repository can be deployed from GitHub to Railway | Verified (previous layout) / live validation required | Previous layout: `railway config apply` with `.railway/railway.ts` created the services from `main`, the images built on Railway, and the Gateway answered a real agent message through Anthropic. One-service layout: deployed from the branch into a scratch Railway project with `railway config apply` (2026-10-08); built, logged in to the tailnet, and passed the health check. Production migrated on 2026-10-08 ([UPGRADING.md](UPGRADING.md#migrating-from-the-two-service-layout)); state inventory unchanged afterwards. |
| 23 | Suitable for a reusable public Railway template | Verified (live) | MIT licensed, public repository, no secrets, generated Gateway token. The published template (one service, asking only for `TS_AUTHKEY`) was deployed into a fresh project on 2026-10-08: it built, logged in, became `openclaw-1` because `openclaw` was taken, and Serve and the QR code followed the real name. Repeated on 2026-10-08 from `main` at `48ba023` with `railway deploy -t openclaw-private-gateway`: healthy 4m24s after the command, one service and one `/data` volume, no domains, a 64-character generated token, `openclaw-1` reachable over the tailnet (`/healthz`, `/readyz`, `/startupz` 200), the dashboard signed in through tailnet identity, and a new Mac app pairing. It found the template page showing `https://openclaw..ts.net` (Railway strips `<tailnet>`; fixed and tested) and the entrypoint logging the requested name instead of `openclaw-1` (fixed). Onboarding was not re-run on this deploy (no provider key); see #22 for the earlier agent reply. |

## Additional features verified live (2026-10-08)

| Feature | Result |
| --- | --- |
| Opt-in webhooks ([WEBHOOKS.md](WEBHOOKS.md)) | Through a Railway domain on the production deployment: `POST /hooks/agent` with the token reached the restricted `mail_reader` agent and completed (`status: ok`); no token gave 401; targeting `main` gave 400. On a scratch deployment: path tokens worked, other paths and methods gave 404, and 20 failures locked out the caller even with rotating `X-Forwarded-For`/`X-Real-IP` headers, while a different real caller still got 401. |
| Security audit with webhooks | 0 critical, 2 warnings after configuration (`trusted_proxies_missing`; `plugins.tools_reachable_permissive_policy`, about the user's own plugins and `main`'s full tool profile). |
| Gmail push | Production: the existing `gog-gmail-watch-push` subscription was repointed to the Railway domain; `hooks.gmail` applied without a restart (watch registered, `gog gmail watch serve` on 127.0.0.1:8788); a real new-mail push became a `mail_reader` hook run that completed (`status=ok`, no delivery). Stale and synthetic pushes were ignored by `gog`. |
| Portals | An agent opened a portal on its own Serve port; over the tailnet it returned the test page (200) with its ticket and 401 without. |
| `gog-login` on production | Google redirected to `https://openclaw.<tailnet>.ts.net:8443/oauth2/callback`, `gog` received the authorization through the tailnet, exchanged the code, and stored a refresh token for the `web` client (`gog auth list --check`: valid; 2026-10-13). The temporary port 8443 route was gone afterwards. |
| Tailscale Funnel for webhooks | Not used: built and tested, but Funnel ingress never reached a userspace-mode node from this container (the official Tailscale container failed the same way). See [WEBHOOKS.md](WEBHOOKS.md#why-not-tailscale-funnel). |

## Live history (previous layout, 2026-10-08)

Project `openclaw`, environment `production`, region `us-west2`, with a separate
`tailscale` service forwarding raw TCP to the Gateway over Railway's private
network:

- The Gateway deploy turned healthy (≈200 s, mostly pulling the base image); the
  root-owned volume was prepared without errors. `railway ssh` reaches the
  domainless service once an SSH key is registered; sessions run as root and
  receive the service's variables.
- Onboarding with Anthropic succeeded; the Gateway restarted itself through
  Railway; `openclaw agent --message` returned a model reply.
- Tailscale joined the tailnet and served `wss://` and `:18789`; audit 0
  critical, 0 warn (with `gateway.publicOrigin`). The macOS app connected as
  primary and was paired.
- Performance: Railway's 1316-byte network MTU dropped full-size Tailscale
  packets (0.6–1.7 s TLS handshakes, ~10 KB/s). `TS_DEBUG_MTU=1236` brought
  handshakes to 65–75 ms and a 20 KB page to 0.25 s.
- Found and fixed in `railway.ts`: undeclared volume region/size produced
  destructive-looking plans, and `apply` cannot move a volume's region.

## Live validation plan (current layout)

Run in a scratch Railway project first, then for the live migration. Each step
lists what to record.

1. **Deploy** ([DEPLOYMENT.md](DEPLOYMENT.md)) with `TS_AUTHKEY` set. Record:
   `railway config plan` (one service, one volume, no domains); the first deploy
   turns healthy through the relay; time to healthy.
2. **Tailscale.** Record: the logs show "logged in to Tailscale" and `serve
   enabled: https://openclaw.<tailnet>.ts.net/`; `curl` from an allowed device
   succeeds and from a disallowed device times out.
3. **Performance.** Record TLS handshake time and transfer speed of a large
   dashboard asset through Serve (checks `TS_DEBUG_MTU` on Railway).
4. **Onboarding.** Record: the container restarts once by itself and returns
   healthy.
5. **Mac app.** Record: connects to `wss://openclaw.<tailnet>.ts.net`; node
   pairing requests appear and approve; Mac capabilities online.
6. **Telegram.** Record: pairing code, approval, agent reply.
7. **Audit.** Record `openclaw security audit --deep`.
8. **Persistence and restarts.** `railway redeploy --service openclaw --yes`.
   Record: same machine and address, no auth key consumed, no new pairing
   requests, Telegram still answers.
9. **Crash recovery.** `railway ssh --service openclaw -- pkill -KILL -f
   openclaw-gateway`, then the same for `tailscaled`. Record: Railway restarts
   the container and it returns healthy.
10. **Backup and restore drill.** Create a Railway backup, change a config value,
    restore, deploy. Record: the value is back.
11. **Upgrade drill.** When the next OpenClaw release ships, follow
    [UPGRADING.md](UPGRADING.md) end to end.
