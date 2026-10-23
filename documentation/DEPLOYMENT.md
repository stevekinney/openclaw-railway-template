# Deployment

Two ways to deploy:

- **Railway template**: one click plus two variables. Follow
  [QUICKSTART.md](QUICKSTART.md). Use this unless you need to change the code.
- **From your fork, with Infrastructure as Code**: this page. Use it when you
  maintain your own fork (`.railway/railway.ts` then describes the project).

Both end at the same place: a Gateway reachable only through your tailnet, with
the macOS app paired and, optionally, Telegram. Tailscale runs inside the
`openclaw` container, and OpenClaw manages Tailscale Serve itself. Steps marked
**live-unverified** have run locally against a real tailnet but not yet on
Railway in this layout; the rest of this page was run against a live Railway
project on 2026-10-08.

## Prerequisites

- A Railway account on a paid plan (volumes larger than 0.5 GB). Public forks
  build without the Railway GitHub app; private forks need it.
- [Railway CLI](https://docs.railway.com/cli) **5.42.1 or newer** (`brew install railway`),
  logged in with `railway login`, plus an SSH key registered with Railway:
  `railway ssh keys add --key ~/.ssh/id_ed25519.pub`. Railway publishes no
  host-key fingerprints for `ssh.railway.com` and rotates keys across hosts, so
  the first connection is trust-on-first-use: accept the prompt once in an
  interactive terminal.
- Node.js 24+ (to evaluate `.railway/railway.ts`).
- A Tailscale tailnet with MagicDNS and
  [HTTPS certificates](https://tailscale.com/kb/1153/enabling-https) enabled.
  Serve requires them; there is no plaintext fallback.

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
| `XDG_CACHE_HOME` variable | `/tmp` (disposable SQLite inspection snapshots use container storage) |
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
dashboard (Variables → ⋯ → Seal) if you don't need to read it back.

Name the Gateway. The name is shown in OpenClaw's apps, and its lowercase,
hyphenated form names the Tailscale machine and the address (`My Gateway` →
`https://my-gateway.<your-tailnet>.ts.net/`). Without it, both are `openclaw`;
this page uses `openclaw` in its examples.

```bash
railway variable set 'OPENCLAW_MACHINE_DISPLAY_NAME=My Gateway' --service openclaw --skip-deploys
```

Then create an auth key in the Tailscale admin console (**Settings → Keys →
Generate auth key**: not reusable, not ephemeral, 1-day expiry, tagged
`tag:openclaw` if your policy defines it; see [TAILSCALE.md](TAILSCALE.md)),
copy it, and set it:

```bash
pbpaste | tr -d '\n' | railway variable set TS_AUTHKEY --stdin --service openclaw
```

That deploys. Watch it:

```bash
railway logs --service openclaw
```

Expect, in order:

- `openclaw-railway: created /data/.openclaw/openclaw.json from the baseline config`
- `openclaw-railway: logged in to Tailscale as openclaw`
- `openclaw-railway: the Gateway will be at https://openclaw.<your-tailnet>.ts.net/` (logged on every start)
- Doctor output, then `[tailscale] serve enabled: https://openclaw.<your-tailnet>.ts.net/`
- `[gateway] http server listening`

Railway marks the deploy healthy once `/startupz` returns 200 through the health
relay (≈3 minutes the first time, mostly pulling the base image). A machine
named after the Gateway is now in your tailnet. If the tailnet already had one with that name, Tailscale adds a suffix (`openclaw-1`), the login line says `logged in to Tailscale as openclaw-1 (asked for openclaw)`, and the address follows; use the address from the `the Gateway will be at` line. From any tailnet device:

```bash
curl -fsS https://openclaw.<your-tailnet>.ts.net/healthz   # {"ok":true,"status":"live"}
```

The first HTTPS request to a new machine takes about 15 seconds while Tailscale
issues its certificate. If the name was already taken, the machine has a `-1`
suffix and the address follows; OpenClaw picks up the real name itself.
**(live-unverified** on Railway in this layout.)

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
onboarding keeps `gateway.tailscale.mode: "serve"` (verified locally). With
`lan`, the next start refuses the config.
For other providers replace `--auth-choice apiKey` (see `openclaw onboard --help`
and [OpenClaw's automation guide](https://docs.openclaw.ai/start/wizard-cli-automation)).

## 6. Confirm the restart

Onboarding rewrites the Gateway settings, which needs a restart. Because Railway is the
supervisor (`OPENCLAW_SUPERVISOR_MODE=external`), the Gateway exits cleanly and
Railway's `ALWAYS` restart policy starts it again. Routine boots of an activated image use Gateway state admission; a new image first runs full Doctor repair. Measure the current deployment's `/startupz` timing rather than relying on an older release's restart time.
Then check that the agent answers:

```bash
railway ssh --service openclaw -- openclaw health
railway ssh --service openclaw -- openclaw agent --agent main --message "Reply with exactly: OK"
```

`openclaw models status --probe` refuses to run while the Gateway holds the
state; the agent message tests the same credential end to end.

## 7. Open the dashboard

On any tailnet device, open `https://openclaw.<your-tailnet>.ts.net/`. The
browser signs in with your Tailscale identity: no token and no device approval
(verified locally against a real tailnet). Anyone your Tailscale access policy
lets reach the machine on port 443 can sign in this way, so check the policy
([TAILSCALE.md](TAILSCALE.md), [SECURITY.md](SECURITY.md)).

If you didn't tag the key, the machine belongs to your user: disable its key
expiry in the admin console, or it leaves the tailnet after 180 days.

## 8. Connect the macOS app

```bash
security find-generic-password -s openclaw-railway-gateway-token -w | tr -d '\n' | \
  /Applications/OpenClaw.app/Contents/MacOS/openclaw-mac primary set \
    --direct-url wss://openclaw.<your-tailnet>.ts.net --token-stdin
```

`primary set` replaces the app's current primary connection (undo with
`openclaw-mac primary set --local`). To keep your current primary and add this
Gateway alongside it, use `openclaw-mac gateway add Railway --url https://openclaw.<your-tailnet>.ts.net --token-stdin`.
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
redeploys; existing pairings carried over the move to this layout. (A
brand-new pairing on this layout is **live-unverified**.)

## 10. Connect Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Store it, and add `TELEGRAM_BOT_TOKEN: preserve()` to `.railway/railway.ts`:

   ```bash
   pbpaste | tr -d '\n' | railway variable set TELEGRAM_BOT_TOKEN --stdin --service openclaw
   ```

   On the next start, OpenClaw enables Telegram with `dmPolicy: "pairing"` and
   `groupPolicy: "allowlist"`, reading the token from the environment (verified
   locally; the token is never written to the volume).
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

**(live-unverified:** Telegram has been tested locally with a dummy token, not
with a real bot on Railway.)

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
| Deep readiness | `curl -fsS https://openclaw.<tailnet>.ts.net/readyz` (tailnet device) | `{"ready":true}` |
| No public exposure | Railway dashboard → `openclaw` → Settings → Networking | no domains, no TCP proxy |
| Loopback-only Gateway | `railway ssh --service openclaw -- openclaw config get gateway.bind` | `loopback` |
| Desktop | `openclaw-mac status --json` | primary `connected` |
| Telegram | DM the bot | agent reply |
| Persistence | `railway restart --service openclaw --yes`, then repeat the Desktop check | still paired, no re-approval |
| Tailscale persistence | After the restart, `railway logs --service openclaw` | `serve enabled` again, no new `logged in to Tailscale`; same machine and IP |

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

Turn on scheduled volume backups in the dashboard (`openclaw` → **Backups** →
Daily and Weekly). The volume holds the Tailscale node key too, so a restore
brings back the same machine. See [UPGRADING.md](UPGRADING.md#5-back-up) for
on-demand backups and restores.

## Maintaining the Railway template

The published template is generated from a separate source project, not from a
live deployment, so no real secret can reach it. Railway's `templateGenerate`
keeps service names, sources, health-check paths, restart policy, volume mount
paths, and template *functions* such as `${{secret(64, "abcdef0123456789")}}`.
The published template sets the supported `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` variable to `600`, matching `.railway/railway.ts`; its editor exposes the health-check path without a timeout field. Confirm this default after every template update, since repository pushes do not update marketplace settings. [Railway documents the timeout variable](https://docs.railway.com/deployments/healthchecks#healthcheck-timeout).

It **drops literal variable values**, marks every variable required, and drops
variable descriptions. That is why the service takes no `PORT` variable and
relies on Railway's default. The template asks for
`OPENCLAW_MACHINE_DISPLAY_NAME` (no default, so each deployment gets its own
machine name) and `TS_AUTHKEY`; it generates `OPENCLAW_GATEWAY_TOKEN`.

**The template's readme** (the text on the template page) lives in [RAILWAY_TEMPLATE.md](RAILWAY_TEMPLATE.md). Railway strips anything that looks like an HTML tag when it saves the readme, even inside backticks, so write placeholders as `your-tailnet`, never `<tailnet>`; `npm run test:railway-config` checks this. To publish a change to the readme, run from the repository root:

```bash
railway api 'mutation($id: String!, $i: TemplatePublishInput!) { templatePublish(id: $id, input: $i) { status } }' \
  --variables "$(jq -n --rawfile readme documentation/RAILWAY_TEMPLATE.md \
    '{id: "<template-id>", i: {category: "AI/ML", description: "Private OpenClaw Gateway, reachable only over your Tailscale tailnet", readme: $readme}}')"
```

`railway api 'query { template(code: "openclaw-private-gateway") { id readme } }'` prints the template's ID and shows the published readme afterwards.

**Small changes** (variables, descriptions, defaults): edit the published
template directly. Railway dashboard → workspace **Templates** → the template →
**Edit** → **Architecture**, open the service's **Variables**, make the change,
review **Details**, and **Apply**. Check the result with
`railway api 'query { template(code: "openclaw-private-gateway") { serializedConfig } }'`.

**Structural changes** (services, volumes, sources): regenerate. Running
`templateGenerate` on a project that already has a template **updates that
template in place**, even when it is published, and the published template's
original source project no longer exists. So:

1. In a scratch project whose service mirrors `.railway/railway.ts`, set
   `OPENCLAW_GATEWAY_TOKEN` to `${{ secret(64, "abcdef0123456789") }}` and
   placeholder values for `OPENCLAW_MACHINE_DISPLAY_NAME` and `TS_AUTHKEY`.
2. `railway api 'mutation($p: String!) { templateGenerate(input: { projectId: $p }) { id code serializedConfig } }' --variables '{"p":"<project-id>"}'`
3. Inspect `serializedConfig`: no secret values, one service, one volume at `/data`. Restore the optional `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` default to `600` and confirm the health-check path is `/startupz`.
4. Deploy it into another scratch project
   (`railway deploy -t <code> -v openclaw.TS_AUTHKEY=…`, with a reusable,
   ephemeral key) and wait for `openclaw` to turn healthy.
5. Publish the new template (a new URL), add the variable descriptions for
   `OPENCLAW_MACHINE_DISPLAY_NAME` and `TS_AUTHKEY` in the template editor, point the README's Deploy button at it,
   and unpublish the old one.
