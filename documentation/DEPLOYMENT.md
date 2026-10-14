# Deployment

Two ways to deploy:

- **Railway template**: one click plus two variables. Follow
  [QUICKSTART.md](QUICKSTART.md). Use this unless you need to change the code.
- **From your fork, with Infrastructure as Code**: this page. Use it when you
  maintain your own fork (`.railway/railway.ts` then describes the project).

Both end at the same place: a Gateway reachable only through your tailnet, with
the macOS app paired and, optionally, Telegram. Tailscale runs inside the
`openclaw` container, and OpenClaw manages Tailscale Serve itself. What has been
verified, and where, is in [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md).

## Prerequisites

- A Railway account on a paid plan (volumes larger than 0.5 GB). Public forks
  build without the Railway GitHub app; private forks need it.
- [Railway CLI](https://docs.railway.com/cli) **5.42.1 or newer** (`brew install railway`),
  logged in with `railway login`, plus an SSH key registered with Railway:
  `railway ssh keys add --key ~/.ssh/id_ed25519.pub` (create the key first with
  `ssh-keygen -t ed25519` if you don't have one). Railway publishes no
  host-key fingerprints for `ssh.railway.com` and rotates keys across hosts, so
  the first connection is trust-on-first-use: accept the prompt once in an
  interactive terminal.
- Node.js 24+ (to evaluate `.railway/railway.ts`).
- A Tailscale tailnet with MagicDNS and
  [HTTPS certificates](https://tailscale.com/kb/1153/enabling-https) enabled.
  Serve requires them; there is no plaintext fallback.
- The device you browse from, with the Tailscale client installed, signed in to
  that tailnet, and connected. The Gateway has no public address.
- A Tailscale auth key:

  > Tailscale auth key settings: not reusable, not ephemeral, pre-approved if your tailnet requires device approval, and tagged `tag:openclaw` if your policy defines it. Expiry, the machine's key expiry, and why: [TAILSCALE.md](TAILSCALE.md#auth-key-settings)

## 1. Create the Railway project

```bash
git clone https://github.com/<you>/<your-fork>.git openclaw-railway
cd openclaw-railway
npm ci
railway init --name openclaw
```

**Choose the region now.** `.railway/railway.ts` places the service and its
volume in `us-west2` unless you set `OPENCLAW_RAILWAY_REGION` (or edit the
`region` constant) before the first apply; region IDs are in
[Railway's regions docs](https://docs.railway.com/deployments/regions). Moving
later means migrating the volume: `railway config apply` reports a volume region
change but does not move the volume. Change the service's region instead
(dashboard → service → Settings → Region), and the volume migrates with it on
the next deploy, with downtime proportional to its size. Then update the region
in `railway.ts` so plans stay clean.

## 2. Create the service and its volume

Point `.railway/railway.ts` at your fork: edit `sourceRepository` in the file
(it then travels with your fork), or export the variable for this shell:

```bash
export OPENCLAW_RAILWAY_REPOSITORY=<you>/<your-fork>
railway config plan
railway config apply
```

The plan shows one service (`openclaw`), one volume (`openclaw-state` at
`/data`), and no domains.

Railway builds the service immediately. The first deploy fails, as expected:
the entrypoint refuses to start until step 3 sets its variables.

<details>
<summary>Dashboard equivalent (no CLI)</summary>

Create one service from your GitHub fork, named `openclaw`. Then:

| Setting | Value |
| --- | --- |
| Root directory | (repository root) |
| Builder | Dockerfile |
| Volume mount path | `/data` |
| Healthcheck path / timeout | `/startupz` / 600 s |
| Restart policy | Always |
| Replicas | 1 |
| Draining seconds | 330 |
| `PORT` variable | **none** (Railway's default, 8080, is where the health relay listens) |
| Public networking | none |

</details>

## 3. Configure the Gateway and Tailscale

Two variables. The token authenticates clients that don't sign in with their
tailnet identity (the Mac app, the CLI, the HTTP API). The Tailscale auth key
logs the container in to your tailnet on first boot; after that, the node key
on the volume does, and the auth key is never read again.

On macOS, generate the token straight into your Keychain and pipe it to Railway,
so it never appears on screen or in your shell history:

```bash
security add-generic-password -U -a openclaw-railway -s openclaw-railway-gateway-token -w "$(openssl rand -hex 32)"
security find-generic-password -s openclaw-railway-gateway-token -w | tr -d '\n' | \
  railway variable set OPENCLAW_GATEWAY_TOKEN --stdin --service openclaw --skip-deploys
```

(Elsewhere: `openssl rand -hex 32 | tee /dev/tty | tr -d '\n' | railway variable set OPENCLAW_GATEWAY_TOKEN --stdin --service openclaw --skip-deploys`,
and save the printed value in a password manager.) Seal the token in the
dashboard (Variables → ⋯ → Seal) if you don't need to read it back; a sealed
value can't be read by `railway variable list` or the dashboard afterwards.

### Rotate the token

Run the same commands again. `-U` replaces the Keychain item, and without
`--skip-deploys` Railway redeploys with the new token. Then update every client
that holds the old one: the Mac app (`openclaw-mac primary set …`, step 8),
and any other client or script. Paired devices keep their own device tokens; to
cut one off, revoke it ([SECURITY.md](SECURITY.md#rotating-credentials)).

Name the Gateway. The display name is shown in OpenClaw's apps, and its
lowercase, hyphenated form is the machine name, which names the Tailscale
machine and the address (`My Gateway` →
`https://my-gateway.<your-tailnet>.ts.net/`; see
[TAILSCALE.md](TAILSCALE.md#tailscale) for both terms). Without it, both are
`openclaw`. This page writes the machine name as `<machine-name>`.

```bash
railway variable set 'OPENCLAW_MACHINE_DISPLAY_NAME=My Gateway' --service openclaw --skip-deploys
```

Then create an auth key in the Tailscale admin console (**Settings → Keys →
Generate auth key**, 1-day expiry; see the settings under
[Prerequisites](#prerequisites)), copy it, and set it:

```bash
pbpaste | tr -d '\n' | railway variable set TS_AUTHKEY --stdin --service openclaw
```

That deploys. Watch it:

```bash
railway logs --service openclaw
```

Expect, in order:

- `openclaw-railway: created /data/.openclaw/openclaw.json from the baseline config`
- `openclaw-railway: logged in to Tailscale as <machine-name>`
- `openclaw-railway: the Gateway will be at https://<machine-name>.<your-tailnet>.ts.net/` (logged on every start)
- Doctor output, then `[tailscale] serve enabled: https://<machine-name>.<your-tailnet>.ts.net/`
- `[gateway] http server listening`

Railway marks the deploy healthy once `/startupz` returns 200 through the health
relay (about 4 minutes the first time, mostly pulling the base image). A machine
named after the Gateway is now in your tailnet. If the tailnet already had one with that name, Tailscale adds a suffix (`<machine-name>-1`), the login line says `logged in to Tailscale as <machine-name>-1 (asked for <machine-name>)`, and the address follows; use the address from the `the Gateway will be at` line. From any tailnet device:

```bash
curl -fsS https://<machine-name>.<your-tailnet>.ts.net/healthz   # {"ok":true,"status":"live"}
```

The first HTTPS request to a new machine takes about 15 seconds while Tailscale
issues its certificate. If the name was already taken, the machine has a `-1`
suffix and the address follows; OpenClaw picks up the real name itself.

## 4. Choose an AI provider

Set the provider's key. Copy it to the clipboard first:

```bash
pbpaste | tr -d '\n' | railway variable set ANTHROPIC_API_KEY --stdin --service openclaw
```

`ANTHROPIC_API_KEY` is already declared in `.railway/railway.ts`. For another
provider ([list](https://docs.openclaw.ai/providers)), set its variable and add it
to the file as `preserve()` ([why](#keeping-variables-in-sync)).

## 5. Initialize the default agent

Run OpenClaw's non-interactive onboarding inside the running container. Inside
`railway ssh` you're root; the image's `openclaw` command drops to the `node`
user for you, and the session sees the service's variables.

```bash
railway ssh --service openclaw -- openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local --auth-choice apiKey --secret-input-mode ref \
  --gateway-auth token --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
  --gateway-bind loopback --skip-channels --no-install-daemon
```

This creates the `main` agent, its workspace under `/data/.openclaw/workspace`,
and an auth profile that *references* `ANTHROPIC_API_KEY` rather than copying it.
Keep `--gateway-bind loopback`: OpenClaw-managed Serve requires it, and
onboarding keeps `gateway.tailscale.mode: "serve"`. With `lan`, the next start
refuses the config.

You can also connect a provider in the dashboard (**Settings → Model Setup →
Connect provider**), which skips this step and step 4. It stores the key on the
volume instead of referencing the variable; see
[QUICKSTART.md](QUICKSTART.md#4-add-your-model-provider).
For other providers replace `--auth-choice apiKey` (see `openclaw onboard --help`
and [OpenClaw's automation guide](https://docs.openclaw.ai/start/wizard-cli-automation)).

## 6. Confirm the restart

Onboarding rewrites the Gateway settings, which needs a restart. Because Railway is the
supervisor (`OPENCLAW_SUPERVISOR_MODE=external`), the Gateway exits cleanly and
Railway's `ALWAYS` restart policy starts it again (back in about 30 s).
Then check that the agent answers:

```bash
railway ssh --service openclaw -- openclaw health
railway ssh --service openclaw -- openclaw agent --agent main --message "Reply with exactly: OK"
```

`openclaw models status --probe` refuses to run while the Gateway holds the
state; the agent message tests the same credential end to end.

## 7. Open the dashboard

On any tailnet device, open `https://<machine-name>.<your-tailnet>.ts.net/`. The
browser signs in with your Tailscale identity: no token and no device approval. Anyone your Tailscale access policy
lets reach the machine on port 443 can sign in this way, so check the policy
([TAILSCALE.md](TAILSCALE.md), [SECURITY.md](SECURITY.md)).

If you didn't tag the key, the machine belongs to your user: disable its key
expiry in the admin console, or it leaves the tailnet after 180 days.

## 8. Connect the macOS app

```bash
security find-generic-password -s openclaw-railway-gateway-token -w | tr -d '\n' | \
  /Applications/OpenClaw.app/Contents/MacOS/openclaw-mac primary set \
    --direct-url wss://<machine-name>.<your-tailnet>.ts.net --token-stdin
```

`primary set` replaces the app's current primary connection (undo with
`openclaw-mac primary set --local`). To keep your current primary and add this
Gateway alongside it, use `openclaw-mac gateway add Railway --url https://<machine-name>.<your-tailnet>.ts.net --token-stdin`.
Details and the in-app route: [DESKTOP.md](DESKTOP.md).

## 9. Approve device pairing

Browsers signed in with their tailnet identity skip this. The Mac app, the
iOS and Android apps, and node hosts pair with a device identity, and their
first connection stays pending until you approve it:

```bash
railway ssh --service openclaw -- openclaw devices list
railway ssh --service openclaw -- openclaw devices approve <requestId>
```

The Mac app files two requests, for the operator role and the node role;
approve both. It then asks for its **node capability surface**, the commands
the agent may run on your Mac, including `system.run`. The app can approve
this request itself from its approval panel, so decide deliberately what you
allow ([SECURITY.md](SECURITY.md#local-node-permissions-the-mac)); from the CLI
it's `openclaw nodes pending` / `openclaw nodes approve <id>`.

Pairing is stored in `/data/.openclaw/state/openclaw.sqlite` and survives
redeploys.

## 10. Connect Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Store it, and add `TELEGRAM_BOT_TOKEN: preserve()` to `.railway/railway.ts`:

   ```bash
   pbpaste | tr -d '\n' | railway variable set TELEGRAM_BOT_TOKEN --stdin --service openclaw
   ```

   On the next start, OpenClaw enables Telegram with `dmPolicy: "pairing"` and
   `groupPolicy: "allowlist"`, reading the token from the environment (the token
   is never written to the volume).
3. DM your bot. It replies with a pairing code and your numeric Telegram user ID.
4. Approve the code. The first approved pairing also becomes the command owner:

   ```bash
   railway ssh --service openclaw -- openclaw pairing approve telegram <CODE>
   ```

5. Lock DMs to yourself (recommended; see [SECURITY.md](SECURITY.md#telegram)):

   ```bash
   railway ssh --service openclaw -- openclaw config set channels.telegram.allowFrom '["<your-user-id>"]'
   railway ssh --service openclaw -- openclaw config set channels.telegram.dmPolicy allowlist
   ```

## 11. Run the security audit

```bash
railway ssh --service openclaw -- openclaw security audit --deep
```

Expected: 0 critical, and the warning `gateway.trusted_proxies_missing`, which
OpenClaw reports for every loopback Gateway without `trustedProxies`, including
its own Serve setup. Don't add `trustedProxies` to silence it: trusting
`127.0.0.1` would trust every process in the container. `--deep` has also
reported `gateway.probe_failed` on every 2026.9.8 install
([why](SECURITY.md#security-audit)).

## 12. Verify the deployment

| Check | Command | Expected |
| --- | --- | --- |
| Version | `railway ssh --service openclaw -- openclaw --version` | `OpenClaw 2026.9.8` |
| Gateway health | `railway ssh --service openclaw -- openclaw health` | OK |
| Deep readiness | `curl -fsS https://<machine-name>.<tailnet>.ts.net/readyz` (tailnet device) | `{"ready":true}` |
| No public exposure | Railway dashboard → `openclaw` → Settings → Networking | no domains, no TCP proxy |
| Loopback-only Gateway | `railway ssh --service openclaw -- openclaw config get gateway.bind` | `loopback` |
| Desktop | `openclaw-mac status --json` | primary `connected` |
| Telegram | DM the bot | agent reply |
| Persistence | `railway redeploy --service openclaw --yes`, then repeat the Desktop check | still paired, no re-approval |
| Tailscale persistence | After the redeploy, `railway logs --service openclaw` | `serve enabled` again, no new `logged in to Tailscale`; same machine and IP |

## Keeping variables in sync

`.railway/railway.ts` describes the whole project. A variable that exists on a
service but not in that file shows up in `railway config plan` as a deletion.
Plans mark deletions as destructive, and a non-interactive apply refuses them
without `--confirm-destructive`, but an interactive apply will remove the
variable if you confirm. So:

- Declare every variable you add to a service in `railway.ts`. Use `preserve()`
  for secrets so the value stays in Railway and never enters the repository.
- Read the plan before every apply.
- Never use `ctx.randomString()` for secrets: it's a SHA-256 of the environment
  name and a label, so anyone can derive it.

## Backups

Scheduled volume backups are set in the dashboard (`openclaw` → **Backups** →
Daily and Weekly). They were not available on the Hobby plan, and Railway's
backup docs don't say which plans include them, so check the tab on yours. The
volume holds the Tailscale node key too, so a restore brings back the same
machine. Without scheduled backups, `openclaw backup create` produces a portable
archive of the Gateway's state on any plan. See
[UPGRADING.md](UPGRADING.md#5-back-up) for both, and for restores.

## Cost and teardown

**What it uses.** One always-on service and one 5 GB volume. Plan on at least
2 GB of memory and 1 vCPU (idle memory is about 0.9 GB for the Gateway, plus
`tailscaled` and the sidecar); browser automation and large agent fleets need
more. The image is about 6 GB, which affects the first build only, and the
volume grows with media, SQLite, the workspace, and tools you install. See
[ARCHITECTURE.md](ARCHITECTURE.md#requirements-and-limits). Railway bills by
usage; see [Railway's pricing](https://docs.railway.com/pricing/plans) for the
rates and what each plan includes. Model provider usage is billed separately by
the provider.

**Removing it.**

1. In Railway, delete the `openclaw` service and its `openclaw-state` volume (or
   the whole project, if it holds nothing else). The volume is where every
   conversation, credential, and the Tailscale node key live, so export what you
   want first ([UPGRADING.md](UPGRADING.md#5-back-up)).
2. In the Tailscale admin console, remove the machine (**Machines → ⋯ →
   Remove**).
3. Under **Settings → Keys**, revoke any auth key you created for it that is
   still valid.
4. Revoke the model provider key, and the Telegram bot token with `/revoke` in
   @BotFather, if you used them.
5. On the Mac, restore the app's own Gateway (`openclaw-mac primary set
   --local`) and delete the Keychain item (`security delete-generic-password -s
   openclaw-railway-gateway-token`).
