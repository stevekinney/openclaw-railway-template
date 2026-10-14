# Upgrading and rolling back

An OpenClaw upgrade is one change: the `FROM` line in `Dockerfile` (tag and
digest). The Gateway never updates itself in place: `OPENCLAW_SUPERVISOR_MODE=external`
makes OpenClaw refuse self-update, and `OPENCLAW_NO_AUTO_UPDATE=1` disables
automatic update checks and applies.

**Merging to `main` deploys.** Railway builds and deploys every push to the
branch it watches. Treat the merge of an upgrade PR as the deploy step below.

## 1. Review the release

- Release notes: <https://github.com/openclaw/openclaw/releases>. A GitHub
  release body only links to the notes; the text is in the repository at
  `CHANGELOG/<version>.md` (`gh api repos/openclaw/openclaw/contents/CHANGELOG/<version>.md -H 'Accept: application/vnd.github.raw'`).
  The npm package carries the same `CHANGELOG.md` and the docs for that exact version:
  `npm pack openclaw@<version> && tar xzf openclaw-<version>.tgz package/CHANGELOG.md package/docs`.
- Read every release between the pinned version and the new one, not only the
  newest; a skipped release's breaking change is still yours.
- Look for config migrations, retired keys, database schema changes, Node
  version changes, and anything under "Upgrading very old versions".
- Check what this template depends on: the `gateway` flags in the Dockerfile's
  `CMD` (`--bind`, `--tailscale`, `--auth`), the keys in
  `config/openclaw.seed.json`, `openclaw doctor --fix` and `docker-entrypoint.mjs`
  (the stock entrypoint), Tailscale Serve, and the `/app/dist/machine-name-*.mjs`
  file that `scripts/patch-machine-display-name.mjs` edits.
- Pick stable releases (`latest`). Avoid `-beta` tags. OpenClaw also publishes
  an `extended-stable` line if you prefer a slower cadence.

## 2. Update the pin

Dependabot opens a PR for new image tags weekly (`.github/dependabot.yml`), and
updates tag and digest together. To do it by hand:

```bash
version=2026.9.9   # example
docker buildx imagetools inspect "ghcr.io/openclaw/openclaw:$version" --format '{{json .Manifest}}' | jq -r .digest
# edit Dockerfile: FROM ghcr.io/openclaw/openclaw:<version>@sha256:<digest>
```

Nothing else references the OpenClaw version. (The Tailscale binaries have
their own `FROM … AS tailscale` line; see [Tailscale upgrades](#tailscale-upgrades).)

The image build runs `scripts/patch-machine-display-name.mjs` against OpenClaw's
compiled `machine-name-*.mjs` and fails if that code changed shape. When an
upgrade trips it, look at that one file in the new image, adapt the patch, and
keep `OPENCLAW_MACHINE_DISPLAY_NAME` working; if OpenClaw gained a setting for
the Gateway's display name, use that and delete the patch.

## 3. Build and validate

CI (`.github/workflows/ci.yml`) runs the static checks first (type-check,
config tests, `node --check`, ShellCheck, Hadolint), then, only if they pass,
builds the image and runs `tests/image.test.sh` against it on every PR. A
separate job also builds the image for `linux/arm64` without running it: `gh`
and `gog` take different checksum branches there, and the tests only run on
amd64. The ShellCheck and Hadolint images are pinned by digest in the workflow,
so bump those by hand. Among other things, it checks that `openclaw --version`
inside the built image equals the `FROM` tag, that a fresh volume boots, that an
existing volume survives a restart, and that auth, proxy attribution, the health
relay, and the security audit still behave. With the optional
`TAILSCALE_TEST_AUTHKEY` repository secret (a reusable, ephemeral auth key), it
also logs a node in to your tailnet and checks Tailscale Serve end to end;
Dependabot pull requests don't receive secrets, so they run the core tier only.
Don't merge on red.

To test an upgrade against a copy of real state, restore an OpenClaw backup
archive (step 4) into a local Docker volume and start the new image on it.

## 4. Back up

Two complementary backups; take both before merging an upgrade.

**Railway volume backup** (restorable in place, whole volume): in the dashboard,
`openclaw` service → **Backups** → **Create backup**. Manual backups are limited
to 50% of the volume size; grow the volume first if needed.

**OpenClaw archive** (portable, verified, off-platform):

```bash
railway ssh --service openclaw -- sh -c 'install -d -o node /tmp/openclaw-backup && openclaw backup create --verify --output /tmp/openclaw-backup && ls /tmp/openclaw-backup'
scp <service-instance-id>@ssh.railway.com:/tmp/openclaw-backup/<archive>.tar.gz .
```

(The service instance ID is in the dashboard: ⌘K → **Copy Service Instance
ID**.) `/tmp` is wiped on redeploy, so copy the archive off first. Always pass
`--output`: the default is the current directory, `/app`, which the `node` user
can't write. Archives contain credentials; store them like secrets. Verified
locally while the Gateway was running; SQLite files belonging to the bundled
Codex runtime are archived as raw bytes with a warning.

## 5. Deploy

Merge the PR. On start, OpenClaw's entrypoint runs `openclaw doctor --fix`
under exclusive state ownership before the Gateway starts, which applies config
and database migrations. Before changing a database schema, Doctor saves
`<database>.pre-startup-migration-<id>.bak` copies beside the originals. The
health check allows 600 seconds for this.

If Doctor can't migrate safely, the container exits with code **78** and Railway
keeps restarting it. Don't delete state or lock files; see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#exit-code-78).

## 6. Verify

```bash
railway ssh --service openclaw -- openclaw --version     # the new version
railway ssh --service openclaw -- openclaw health
railway ssh --service openclaw -- openclaw status        # channels, agents
railway ssh --service openclaw -- openclaw security audit --deep
```

- **Desktop:** Mac app → Connection → **Test**. If the dashboard reports a
  protocol mismatch, hard-refresh or clear its site data.
- **Tailscale:** the deploy log shows `[tailscale] serve enabled: https://…/`
  again, with no new `logged in to Tailscale` line.
- **Channels:** send a Telegram DM; check `openclaw status` shows Telegram OK.

## Rolling back

**Rolling back the image does not roll back state.** Doctor migrates schemas
forward, and older releases refuse newer database schemas. A rollback is
therefore "old image + the backup taken before the upgrade":

1. Revert the upgrade commit and push. The old image starts and will likely
   refuse the migrated state (exit 78). That's expected, and safer than
   proceeding.
2. **Backups** → choose the pre-upgrade backup → **Restore**. Railway mounts a
   new volume from the backup and keeps the current one unmounted for
   inspection.
3. Review the staged change and **Deploy**. The old image now starts on the old
   state.

Anything written after the backup (conversations, pairings, config changes) is
lost in a rollback; the unmounted volume still has it if you need to recover
something by hand. **(live-unverified: the restore flow follows Railway's backup
docs.)**

Tools you installed or updated on the volume (`~/.local`, Homebrew in
`/data/linuxbrew`) and Tailscale's node state (`/data/tailscale`) are part of
that volume state: an image rollback leaves them
as they are, and a volume restore returns them to the backup's versions.

Railway's **Rollback** button (redeploy a previous image) is only safe for
releases that did not migrate state; read the release notes first.

## Tool upgrades

The image's skill tools are a baseline; you can also update them on the volume
without a deploy ([TOOLS.md](TOOLS.md#keeping-tools-current)). To move the
baseline itself:

- **`gh`, `gog`**: downloaded in `Dockerfile` `RUN` steps, which Dependabot
  doesn't track. Change the version and both checksums (amd64 and arm64),
  copied from the release's checksums file (for `gh`:
  `gh release download v<version> -R cli/cli -p 'gh_*_checksums.txt'`; for
  `gog`: `checksums.txt` on the release). The build fails if a checksum doesn't
  match.
- **Release watch**: since Dependabot can't see those pins, the weekly
  `.github/workflows/release-watch.yml` reads `gh_version`, `gog_version`, and
  `brew_version` out of the `Dockerfile` and compares them with each project's
  latest GitHub release. It opens one issue, "Pinned tool releases are out of
  date", listing what is stale, updates it on later runs, and closes it when
  everything is current. It only reports; run it from the Actions tab
  (**Run workflow**) to check on demand.
- **Claude Code**: Dependabot proposes updates to `tools/package-lock.json`;
  merging one redeploys. By hand, change the version in `tools/package.json`
  and run `npm install --package-lock-only` in `tools/`.
- **Codex**: follows OpenClaw's own pin, so it moves with OpenClaw upgrades.
- **Debian packages** (`jq`, `tmux`, ImageMagick): not pinned; every rebuild
  installs Debian's current security updates. Redeploy periodically to pick
  them up. Because the packages float, rebuilding the same commit later is not
  byte-reproducible: the pinned images and downloads are identical, the apt
  layer is not.
- **Homebrew**: the `Dockerfile` pins the seed copied onto a new volume. An
  existing volume's Homebrew updates itself and ignores the seed. It pins the
  tag (`brew_version`) and the commit that tag points to (`brew_commit`), and
  the build fails if the clone's `HEAD` isn't that commit, so a moved tag can't
  change the seed. Get the commit with
  `git ls-remote https://github.com/Homebrew/brew refs/tags/<tag>` and change
  both together.

`tests/image.test.sh` checks that each tool runs.

## Tailscale upgrades

Dependabot proposes new `tailscale/tailscale` tags for the `FROM … AS tailscale`
line in `Dockerfile` (tag and digest together). The image copies only the
`tailscale` and `tailscaled` binaries from it, and CI checks that
`tailscale version` matches the tag. Node state on the volume carries across
versions; roll back by reverting the commit.

## Migrating from the two-service layout

Deployments created before Tailscale moved into the `openclaw` container had a
separate `tailscale` service and volume, raw TCP forwarding, and
`OPENCLAW_PUBLIC_ORIGIN`. The new image refuses to start on such a volume, with
a message naming the config commands below. This was run on a production
deployment on 2026-10-08, in this order; the Gateway was unreachable for about
3 minutes (steps 3–5).

0. **Back up.** Railway volume snapshots weren't available on the Hobby plan, so
   take OpenClaw's archive plus your home directory, copy both off Railway, and
   check them:

   ```bash
   railway ssh --service openclaw
   install -d -m 700 -o node -g node /tmp/backup
   as-node sh -c 'cd /tmp/backup && openclaw backup create --verify --output /tmp/backup'
   tar -C /data -czf /tmp/backup/home.tar.gz home && cd /tmp/backup && sha256sum * > SHA256SUMS
   ```

   Then from your machine, using the deployment instance ID (dashboard, or
   `railway deployment list` plus the API's `deployment { instances { id } }`):
   `scp <instance-id>@ssh.railway.com:/tmp/backup/* ./backup/` and
   `shasum -a 256 -c SHA256SUMS`. The archive and tarball contain credentials;
   keep them private.
1. **Set the auth key** on the `openclaw` service without redeploying (a new
   key: single-use, not ephemeral):

   ```bash
   pbpaste | tr -d '\n' | railway variable set TS_AUTHKEY --stdin --service openclaw --skip-deploys
   ```

2. **Migrate the config** from a shell on the running deployment. Order matters:
   OpenClaw rejects `tailscale.mode serve` while `bind` is `lan`.

   ```bash
   railway ssh --service openclaw -- openclaw config set gateway.bind loopback
   railway ssh --service openclaw -- openclaw config set gateway.tailscale.mode serve
   railway ssh --service openclaw -- openclaw config unset gateway.publicOrigin
   railway ssh --service openclaw -- openclaw config unset plugins.entries.device-pair
   ```

   Do steps 2–4 in one sitting: if the old container restarts in between, it
   can't start with this config. Deploying the new image fixes that.
3. **Deploy** the new image (merge it, or redeploy if `main` already has it).
4. **While it builds, free the machine name.** Stop the old `tailscale`
   deployment (dashboard, or the API's `deploymentStop`; keep its volume until
   you've verified the result), then remove the old `openclaw` machine in the
   Tailscale admin console. Otherwise the new container registers as
   `openclaw-1` and clients configured for `openclaw.<tailnet>.ts.net` stop
   connecting. If you see `logged in to Tailscale as openclaw-1 (asked for openclaw)`, the old machine was still registered. Expect `logged in to Tailscale as openclaw` and
   `[tailscale] serve enabled: https://openclaw.<tailnet>.ts.net/` in the new
   deployment's logs. A config with many plugins took about 2 minutes to pass
   the health check on first boot.
5. **Verify.** The Mac app reconnected on its own (pairings live on the
   `openclaw` volume); the dashboard opened signed in through tailnet identity;
   `openclaw qr` showed the `wss://` address; paired devices, agents, auth
   profiles, channels, and tool logins were unchanged.
6. **Remove the old service.** With the new `.railway/railway.ts`,
   `railway config plan` shows the `tailscale` service and
   `OPENCLAW_PUBLIC_ORIGIN` as deletions; `railway config apply` removes them.
   Deleting the variable redeploys the Gateway once (Railway can't skip that).
   Deleting the service left its `tailscale-state` volume behind, detached;
   delete it in the dashboard or with the API's `volumeDelete`.
7. **Tidy up.** Disable key expiry on the new machine (or tag it).

## Migrating from the previous deployment

Moving data from the old `arjunkomath/openclaw-railway-template` deployment is a
separate, approved operation and not covered here. Don't point this template at
the old volume.
