# Troubleshooting

Start with the logs: `railway logs --service openclaw`. Lines from this
template's entrypoint and sidecar start with `openclaw-railway:`; Tailscale's
own lines (from `tailscaled`) and OpenClaw's `[tailscale]` lines are in the same
log.

## The `openclaw` service won't start

| Log line | Cause | Fix |
| --- | --- | --- |
| `openclaw-railway: OPENCLAW_GATEWAY_TOKEN is not set` (exit 64) | Missing variable. | [DEPLOYMENT.md step 3](DEPLOYMENT.md#3-configure-the-gateway-and-tailscale). |
| `… must be at least 32 characters` | Weak token. | `openssl rand -hex 32`. |
| `PORT is 18789, the Gateway's own loopback port` | A `PORT` variable collides with the Gateway. | Delete the `PORT` variable; Railway then injects 8080 for the health relay. |
| `Tailscale is not logged in (state: NeedsLogin) and TS_AUTHKEY is not set` | First boot without a key, or the machine was removed from the tailnet (its node key no longer works). | Create an auth key and set `TS_AUTHKEY` on `openclaw` ([TAILSCALE.md](TAILSCALE.md)). |
| `Tailscale login failed; see the error above`, after `invalid key: unable to validate API key` or similar | The key was already used (keys are single-use unless created reusable), expired, or revoked. | Generate a new key and set `TS_AUTHKEY` again. |
| `state: NeedsMachineAuth`, or `Tailscale login failed` after `tailscale up` times out | Your tailnet requires device approval, and the key wasn't pre-approved. | Approve the machine in the admin console and redeploy, or use a pre-approved key. |
| `… is set up for the previous layout (a separate tailscale service)` | The volume's config is for the old two-service layout (`gateway.bind: "lan"`, `publicOrigin`, a device-pair `publicUrl`). | Run the four commands the message names, then redeploy. See [UPGRADING.md](UPGRADING.md#migrating-from-the-two-service-layout). |
| `[tailscale] serve failed: Logged out.`, then the Gateway exits | The Gateway started while Tailscale was logged out. The entrypoint normally logs in first, so this means the login was lost while running. | Redeploy; if the entrypoint then reports `NeedsLogin`, set a new `TS_AUTHKEY`. |
| `openclaw-railway: tailscaled exited (…); stopping the container` | Tailscale's daemon died; the sidecar stops the container so Railway restarts both. | Nothing if it recovers. If it repeats, read the `tailscaled` lines just before it. |
| `the entrypoint must start as root` | `RAILWAY_RUN_UID` or a user override is set. | Remove it. The entrypoint drops to `node` itself. |
| `warning: /data is not a mounted volume` | No volume at `/data`. State will be lost. | Attach the volume at `/data` (`requiredMountPath` normally blocks this deploy). |
| `Doctor could not enter maintenance … failed to acquire gateway state ownership` | Usually a permission problem (it shows up with EACCES on a root-owned volume), or another Gateway really holds the state. | Redeploy: the entrypoint repairs ownership on every start. Never delete lock files. |
| `Gateway start blocked: existing config is missing gateway.mode` (exit 78) | `openclaw.json` was replaced by a config without `gateway.mode`. | In [maintenance mode](#exit-code-78), run `openclaw config set gateway.mode local`, or restore `openclaw.json.last-good` / `.bak` from `/data/.openclaw`. |
| `Config file is not readable by the current process` | A file in the state directory is owned by root. | Redeploy; the entrypoint hands every file back to `node`. Run `openclaw` from `railway ssh` (the wrapper runs it as `node`), not `node /app/openclaw.mjs`. |

### Exit code 78

OpenClaw exits 78 when state can't be migrated safely (conflicting identities,
unreadable data, another writer, or a filesystem missing a required primitive).
The log names the failing check. **Don't delete state, lock, claim, or backup
files to silence it**; they are the recovery inputs.

- After an upgrade: roll back ([UPGRADING.md](UPGRADING.md#rolling-back)).
- To run Doctor by hand: put the service in maintenance mode, which keeps the
  container alive without starting the Gateway. In the dashboard, set the
  `openclaw` service's **Start Command** to `sleep infinity` and clear its
  **Healthcheck Path**, deploy, then:

  ```bash
  railway ssh --service openclaw -- openclaw doctor --fix
  ```

  Restore both settings afterwards. Verified locally: with this image,
  `sleep infinity` runs as `node` through the normal entrypoint and Doctor runs
  from an exec shell. Whether Railway's Start Command replaces only the `CMD`
  (as this assumes) is **live-unverified**.

## `railway config plan` proposes a destructive volume change

`Update <volume> config.region` (or `config.sizeMB`) marked destructive means the volume's actual placement differs from `region` / `volumeSizeMB` in `.railway/railway.ts`. Railway marks a volume decrease destructive, and its [volume reference](https://docs.railway.com/volumes/reference) says down-sizing is unsupported. For an existing volume larger than the 5,000 MB new-project default, set `OPENCLAW_RAILWAY_VOLUME_SIZE_MB` to its current `sizeMB` from `railway status --json`, as shown in [DEPLOYMENT.md](DEPLOYMENT.md#2-create-the-service-and-its-volume), then plan again and confirm the plan contains no `config.sizeMB` change. `railway config pull --json` also shows the current volume size. For a region mismatch, move the service's region in the dashboard; the volume migrates with the service on its next deploy. See [DEPLOYMENT.md](DEPLOYMENT.md#1-create-the-railway-project).

## The deploy health check fails

Railway calls `GET /startupz` on port 8080 with Host `healthcheck.railway.app`
for up to 600 seconds. The sidecar relays it to the loopback Gateway, which
answers 200 only after Tailscale Serve is up.

- The logs end in Doctor output on image activation: compare log timestamps with the deployment's health-check window. Keep `XDG_CACHE_HOME=/tmp` so disposable SQLite inspection snapshots do not repeatedly copy and sync databases on the persistent volume. Recovery captures remain on the volume. Check resource metrics and storage latency before retrying; see exit 78 above if Doctor reports a migration failure.
- The entrypoint stopped at a Tailscale error: see the table above.
- `/startupz` doesn't depend on channels, so a broken Telegram token does not
  fail deploys. `/readyz` does (it returns 503 with an invalid token; observed).
- Because the volume can't be shared between deployments, a failed deploy
  leaves the service down rather than on the previous version.

## The container restarts after a config change

Expected. Some settings (for example `gateway.port`, `browser.enabled`) need a
restart. In external-supervisor mode the Gateway exits cleanly
(`restart mode: full process restart (supervisor restart)`) and Railway's
`ALWAYS` restart policy starts it again. If it does *not* come back, check that
the restart policy is `ALWAYS`, not `ON_FAILURE`.

## Tailscale

| Symptom | Cause | Fix |
| --- | --- | --- |
| Machine has a `-1` suffix (`my-gateway-1`) | The name was already taken, usually by an earlier deployment with the same Gateway name. Everything follows the real name (Serve, origin, QR); only clients you configured by hand still point at the old one. | Remove the stale machine and rename this one in the admin console, or point clients at the suffixed name. `railway ssh --service openclaw -- tailscale status --json` shows the name (`Self.DNSName`). |
| Deploy stops with `has no letters or digits to make a Tailscale machine name from` | The Gateway's name (`OPENCLAW_MACHINE_DISPLAY_NAME`) is only symbols, emoji, or non-Latin script, so no DNS label can be made from it. | Add letters or digits to the name, or keep it and set `TS_HOSTNAME` (for example `openclaw`). |
| Changed `OPENCLAW_MACHINE_DISPLAY_NAME`, but the address stayed the same | The machine name is chosen only when Tailscale logs in (first boot). | Rename the machine in the Tailscale admin console, then restart the service so OpenClaw picks up the new address. |
| `curl https://openclaw.<tailnet>.ts.net` times out | Access policy doesn't allow your device, or the machine is offline. | Check the policy grant and `tailscale ping openclaw`. |
| The first HTTPS request takes ~15 s | A new machine's certificate is being issued. | Nothing; later requests are fast. |
| HTTPS never works and the Gateway fails to start Serve | Tailnet HTTPS certificates are not enabled. There is no plaintext fallback. | Admin console → DNS → HTTPS Certificates, then redeploy. |
| Google shows `redirect_uri_mismatch` during `gog-login` | The client is a Desktop app client, or its redirect URI doesn't match the one `gog-login` printed (machine name, `:8443`). | Use a Web application client and register exactly the printed URI. New clients can take a few minutes to take effect. [TOOLS.md](TOOLS.md#google-gog) |
| `gog-login`'s callback page never loads | The browser isn't on the tailnet, or the access policy doesn't allow port 8443. | Open the URL on a tailnet device; allow `tcp:8443` ([TAILSCALE.md](TAILSCALE.md)). |
| Machine logged out after months | Untagged machine hit key expiry. | Tag it or disable key expiry, then set a new `TS_AUTHKEY` and redeploy. |
| Everything works but is slow: HTTPS handshakes take ~1 s, pages load at ~10 KB/s, while `tailscale ping` is fast | Tunnel packets larger than Railway's 1316-byte MTU are being lost. | Make sure the image's `TS_DEBUG_MTU=1236` is in effect and that no variable overrides it. Check with `curl -w '%{time_appconnect}\n' -o /dev/null -s https://openclaw.<tailnet>.ts.net/healthz` (expect well under 0.2 s after the first request). |

## Connecting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `pairing required` / `disconnected (1008)` | New device. | `openclaw devices list`, then `approve <requestId>`. |
| `Proxy client attribution is required …` (403) | A request reached the Gateway's ordinary loopback listener with `X-Forwarded-*` or `Tailscale-*` headers, for example from a process in the container or a hand-made Serve route. Only OpenClaw's own Serve listener accepts them. | Use the Serve URL. Don't add `trustedProxies`. |
| Security audit warns `gateway.trusted_proxies_missing` | Expected: OpenClaw reports it for every loopback Gateway without `trustedProxies`, including its own Serve setup. | Nothing. Trusting `127.0.0.1` to silence it would trust every process in the container. |
| `missing scope: operator.read` from a remote CLI with `--url` | `--url` connections without a paired device identity get no operator scopes. | Run operator commands through `railway ssh`, or pair the client. |
| Mac app: dashboard works but Mac capabilities offline | The node role or its capabilities aren't approved. | `openclaw devices list` and `openclaw nodes pending`; approve. |
| `openclaw qr`: `This Gateway URL uses plaintext ws://, so the setup code was limited` | `gateway.tailscale.mode` isn't `serve` in the config file, so `openclaw qr` falls back to a bind-derived address. | `openclaw config get gateway.tailscale.mode` should print `serve`; see [UPGRADING.md](UPGRADING.md#migrating-from-the-two-service-layout). |
| `Protocol mismatch` in the dashboard after an upgrade | Stale cached UI. | Hard-refresh or clear site data for the dashboard origin. |
| `401 Unauthorized` everywhere | Wrong or rotated token, or too many failures. | Check the token; after 10 failures in a minute, the client is locked out for 5 minutes. |

## `railway ssh` commands

- Inside `railway ssh` you're root; `openclaw` runs as `node` automatically.
  Calling `node /app/openclaw.mjs` directly bypasses that and can create
  root-owned files.
- SSH sessions receive the service's Railway variables (verified on a live
  deployment), so the CLI authenticates to the Gateway without extra setup.
- `Host key verification failed`: `ssh.railway.com` isn't in `~/.ssh/known_hosts`.
  See the SSH note under [Prerequisites](DEPLOYMENT.md#prerequisites). Where no prompt can be answered (a script or an agent), `ssh-keyscan ssh.railway.com >> ~/.ssh/known_hosts` makes the same trust-on-first-use decision.
- `{"status":"no_ssh_key", …}` although `railway ssh keys list` shows your key as registered: no key was offered on the connection, usually because the key has a passphrase and isn't loaded in the SSH agent (`ssh-add -l` says `The agent has no identities`). Load it with `ssh-add --apple-use-keychain ~/.ssh/id_ed25519` on macOS (`ssh-add ~/.ssh/id_ed25519` elsewhere). Until then, approve devices from the dashboard (**Settings → Devices**).
- `No registered SSH keys found`: `railway ssh keys add --key ~/.ssh/id_ed25519.pub`.
  (`railway ssh keys github` can fail with "You do not have access to this
  resource" when Railway's GitHub integration lacks access.)
- `openclaw models status --probe` refuses to run while the Gateway holds the
  state. Test the provider through the Gateway instead:
  `openclaw agent --agent main --message "Reply with exactly: OK"`.
- `openclaw security audit` reports `gateway.trusted_proxies_missing`; that is
  expected (see [Connecting](#connecting)). `--deep` also reports
  `gateway.probe_failed (missing scope: operator.read)` on 2026.9.8, including
  on the unmodified upstream image. See [SECURITY.md](SECURITY.md#security-audit).
- `tailscale` works in a root `railway ssh` shell too (for example
  `tailscale status`); it talks to the daemon over its socket.

## Webhooks and Gmail

| Symptom | Cause | Fix |
| --- | --- | --- |
| `POST /hooks/...` on the Railway domain returns 404 | `OPENCLAW_RAILWAY_WEBHOOKS` isn't `on`, the method isn't `POST`, or the path isn't `/hooks/<name>` or `/gmail-pubsub`. | Set the variable (it redeploys); check the URL. |
| 503 `hooks token not configured` | `OPENCLAW_HOOKS_TOKEN` isn't set on the service. | Set it; it redeploys. |
| 401 from the relay | Missing or wrong hooks token. | Send `Authorization: Bearer <token>`, `x-openclaw-token`, or `/hooks/<name>/<token>`. Query-string tokens aren't accepted. |
| 429 `too many failed attempts` | 20 failures from that caller within a minute; locked out for 10 minutes. | Fix the token and wait. Other callers aren't affected. |
| 400 naming the agent | The hook targets an agent outside `hooks.allowedAgentIds`. | Target `mail_reader` (or add the agent deliberately). |
| Startup refusal: `hooks.gmail.tailscale.mode is …` | OpenClaw's Gmail watcher would run Tailscale Funnel on port 443 and publish the dashboard. | `openclaw config set hooks.gmail.tailscale.mode off`; publish through the Railway domain ([WEBHOOKS.md](WEBHOOKS.md)). |
| `gog-login`: `state mismatch`, and the callback page then shows `404 page not found` | `gog` accepts one callback per run. A callback from an earlier attempt (a stale tab, a reload) arrived first, so `gog` exited and the temporary route closed. | Close old `…:8443/oauth2/callback` tabs, rerun `gog-login`, and open only the new URL. |
| `gog-login`: `no refresh token received; try again with --force-consent` | The account already granted these scopes to the project, so Google skipped the consent screen. | Rerun `gog-login` with `--force-consent`. |
| Gmail watcher can't read its token | `GOG_KEYRING_PASSWORD` isn't set as a Railway variable; the watcher runs without a terminal. | Set it to `gog`'s keyring password. |
| A portal shows "Waiting for the app on port …" | The development server isn't running; a server started in the background by an agent turn run from the CLI didn't outlive the turn. | Start the server again (or ask the agent from the dashboard or a chat); the portal reconnects. |

## Running the tests locally

- `npm run test:image` stops at the first `FROM` with `failed to fetch oauth token: denied: denied`, and `docker pull ghcr.io/openclaw/openclaw:…` says `error from registry: denied`: Docker is sending a stale GitHub Container Registry login. The OpenClaw image is public and needs no login, but a revoked or expired token stored by `docker login ghcr.io` is rejected instead of ignored, and Docker Desktop sends the stored login even with an empty `DOCKER_CONFIG`. Run `docker logout ghcr.io`, or log in again with a token that has the `read:packages` scope.
