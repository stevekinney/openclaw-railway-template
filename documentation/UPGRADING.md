# Upgrading and rolling back

The runtime extends the pinned OpenClaw image with a source-built capture engine patch in `scripts/openclaw-plugin-capture.patch`. `Dockerfile` pins the upstream source commit, archive checksum, Node image, Bun image, and released runtime image. The `openclaw-source-tests` Docker stage runs the capture and companion regression suites. The image test script requires this stage to pass before building and verifying the runtime image. Production builds independently inherit the same prepared source, regenerate runtime bundles and the matching Control UI, and install production dependencies from the patched source lockfile. They retain dependency audits and runtime guards without repeating the CI suites or inheriting test-generated artifacts. The release supplies the baseline plugin selection, with Slack and ACPX added explicitly. The patch removes a duplicate cold-copy hashing pass and keeps disposable plugin execution copies in container temporary storage. Warm receipt comparison verifies ordinary copied files before deciding whether to replay native bytes, so unchanged native executables are not reread. Native admission custody is shared across compiled module graphs, preserving verified receipts and artifact ownership between startup phases. Published native plugin artifacts stay on the volume, and explicit inspection storage scopes remain honored. Receipt framing, original-source verification, native admission, and capture cleanup retain their existing checks.

The template also enables image activation receipts: a new OpenClaw build runs full Doctor repair before Gateway, while routine boots of that build use Gateway state admission. After an unclean container exit, admission waits within its existing budget for uncertain ownership to resolve; it never reads through a fresh foreign ownership record.

The baseline explicitly sets `agents.defaults.heartbeat.directPolicy` to `allow`, preserving OpenClaw's permissive DM default. Existing configurations remain untouched. If an agent defines its own heartbeat delivery target, set its own `heartbeat.directPolicy` explicitly as well; Doctor checks authored heartbeat settings independently. This policy does not select a delivery destination or send a heartbeat.

The patch also backports [Doctor's settled preflight reuse](https://github.com/openclaw/openclaw/pull/180576) and [Gateway's per-plugin startup borrowing](https://github.com/openclaw/openclaw/pull/184246). Doctor reuses its completed legacy-state scan only while configuration and plugin inventory remain unchanged and no migration is unresolved. Gateway offers the current live registry to the existing loader even when agent workspaces differ; the loader still checks each plugin's source, manifest, activation, policy, validated configuration, and lifecycle before borrowing its instance. Workspace replacements load independently. These changes remove duplicate preparation without removing checks or sharing independently owned Doctor callbacks.

Gateway source acquisition prepares up to four independent external plugins at once, bounded by available CPUs. Evaluation, registration, and diagnostics remain in manifest order. Bundled, retained, and recovered plugins form ordering boundaries. Failed or retired loads join pending captures and release their resources before returning; synchronous CLI loads still acquire sources inline. Readiness waits for the complete registry. Native ESM hooks check the captured artifact directory before requesting module classification or preparation from its worker. Host modules outside that directory avoid unrelated worker calls; captured modules retain availability checks, preparation, and their existing source and native-admission owners.

Codex declares the individual legacy sidecars and session indexes that its migration can modify, plus the shared SQLite database. Recovery inventory excludes read-only transcripts and unrelated session files, avoiding whole-directory captures. The source-test stage runs this inventory regression alongside the Codex worker checks.

Healthy shared-state maintenance leaves `PRAGMA user_version`, schema metadata, and SQLite bytes unchanged. Real version or ownership repairs still write their metadata and pass the existing admission checks. This removes writes that changed an otherwise healthy database during every maintenance pass.

Deferred legacy config repairs also preserve authored include identities when a configuration directory is addressed through a symlink. Canonical aliases used for file watching do not require duplicate write identities. Missing hashes or targets, source edits, and profile changes still refuse the prepared write.

Within each database backup, Doctor reuses the committed-content digest only when the exact raw generation and complete WAL header match. Each inspection still reads and verifies the source generation and WAL header before and after; a failed inspection does not seed that database’s cache. The cache ends with the backup operation. Database discovery and backup workers use the existing private SQLite staging owner under `XDG_CACHE_HOME`, so the template's `/tmp` setting also applies to their disposable copies. Verified backup output and its final directory sync remain on `/data`. Before a full integrity scan, prepared private database images are read sequentially with a bounded buffer. The early digest grants no admission and never replaces the later content hash or either full integrity check; live source files are not prefetched. Failed or interrupted Doctor runs never record activation. The receipt is private, atomically replaced, and bound to the build, applied patch, entrypoint, profile, and state selection.

Bundled workers resolve `openclaw/plugin-sdk/*` through a self-link to the exact packaged host. Keep `/app/node_modules/openclaw` linked to `/app` after pruning; parent-process SDK resolution hooks do not carry into worker threads. The image build runs a real Codex history-worker round trip and rejects missing or foreign host links, mismatched versions, and incomplete worker results.

Standalone Doctor recovery captures retain the newest three sealed copies for up to 30 days. The current repair capture stays protected. Incomplete captures, captures with recorded outcomes, and update-associated recovery copies are excluded from automatic retirement. Retirement runs after a new pre-repair capture is sealed, under Doctor maintenance custody, and rechecks each candidate before deletion. This bounds repeated activation snapshots without changing update rollback evidence.

A consistent backup restored with a matching activation receipt follows the same-image Gateway admission policy. Restoring state does not trigger a fresh Doctor recovery capture by itself. To require full Doctor repair and a new recovery capture after a restore, remove `/data/.openclaw/railway-image-activation.json` before starting the container.

An upgrade must update the runtime image and source revision together, revalidate or remove the patch against that release, and run the image tests. The build fails if the patch no longer applies or the rebuilt version differs from the runtime image. The Gateway never updates itself in place: `OPENCLAW_SUPERVISOR_MODE=external` refuses self-update, and `OPENCLAW_NO_AUTO_UPDATE=1` disables automatic update checks and applies.

**Merging to `main` deploys.** Railway builds and deploys every push to the
branch it watches. Treat the merge of an upgrade PR as the deploy step below.

## Slack routing companion

Every image build also applies the complete Slack routing companion from `stevekinney/openclaw-plugin-slack-workspace`. `Dockerfile` pins an immutable Git commit and the patch’s SHA-256 checksum. The build verifies the upstream source commit and version against the selected release image, checks and applies both patches, runs the routing regressions and complete Slack suite, and rebuilds the selected bundled channels. Slack is selected explicitly because the upstream release excludes it. Its production dependencies use OpenClaw’s package-lock generator, which validates versions and integrity against the source pnpm lockfile, followed by `npm ci`. The image retains that production lockfile beside the Slack channel. A conflicting or incomplete upgrade fails before deployment. Never remove a gate or the routing patch to make an upgrade build pass.

The final image records `slackRoutingPatchDigest` and `slackRoutingContractVersion` in `/app/dist/build-info.json`. Its runtime check activates an isolated registry through the real OpenClaw plugin loader, registers the routing hook and interactive handler, and requires a registration receipt. Both bundled companions must complete full registration and activation with source paths and versions matching the host. Missing dependencies, shadowed bundles, and mismatched versions reject the image. The probe blocks network access and uses disposable state. Image tests repeat the check and compare the image's digest with the Dockerfile pin.

Shared runtime chunks under `/app/dist` resolve packages through `/app/dist/node_modules`. The build links each companion's source-installed production packages there, while each companion keeps its own audited dependency tree. Repeated links must resolve to the same canonical package; conflicting owners fail the build. A successful metadata inspection alone does not prove that full registration can resolve these shared imports.

Select the image’s matched Slack channel once with `openclaw plugins install slack` after deploying this companion image. The supported bundled installer persists `/app/dist/extensions/slack` as both source and install path. That stable path resolves to each new image’s rebuilt channel, so an older separately installed archive cannot shadow it. Preserve the Slack account settings and the `slack-workspace` routing configuration. Verify the selected source with `openclaw plugins info slack --runtime --json`; it must identify the image’s bundled path and current release version.

When upgrading OpenClaw, update the release image, source commit/archive checksum, and builder/runtime Node pins together as required by that release. Rebase the companion patch in the plugin repository, run its tests against the new source, commit and push it, then update the immutable patch URL and checksum here. Keep the image’s full test suite green before merging. A version upgrade is not complete until retained-state startup, both Slack connections, exact-session thread replies, Block Kit inputs, and archived-session fallback pass. Routing must stay enabled throughout these checks; disabling it does not satisfy the upgrade gate.

## Image-owned ACPX runtime

The image also builds [ACPX](https://docs.openclaw.ai/plugins/reference/acpx) from the pinned host source. Its production dependencies come from the same source lockfile, with the generated npm lockfile retained beside the plugin. The build replaces the dependency directory completely and verifies ACPX registration, source path, and version through the real host with network access blocked. Missing or mismatched ACPX bundles reject the image. The builder and final runtime both verify their resolved Zod, Undici, and Express body-parser versions. Both companion dependency installs must also pass `npm audit`; warnings cannot silently pass the image build.

For a volume with an older separately installed ACPX package, select the image-owned copy once with `openclaw plugins install acpx --no-enable`. This preserves existing enablement while the supported installer replaces the installation record and package. Preserve ACPX configuration and session state; do not delete its state directory. Read back `openclaw plugins info acpx --runtime --json`: the source and installation path must resolve under `/app/dist/extensions/acpx`, and its version must match the host. That stable path follows later image upgrades instead of leaving an older archive on the volume in charge.

When the retained package is slowing Doctor itself, select the bundled copy before Doctor starts. For that first deployment, set Railway's custom start command to the complete command below. Railway replaces the image entrypoint when a custom start command is set, so the privilege drop and `tini` must remain in the command.

```sh
openclaw-railway-entrypoint tini -s -- node /app/docker-entrypoint.mjs node /app/openclaw.mjs --select-bundled-plugin acpx gateway --bind loopback --tailscale serve --auth token
```

The activation adapter validates every selected bundle's image path, manifest identity, and matching host version before starting the supported installer with `--no-enable`. Selection then runs full Doctor and records activation only after success. Failed or interrupted installation prevents Doctor, Gateway, and receipt publication. The receipt includes the ordered selection list, so an identical image and command reuse the completed activation on routine restarts. Changing the image, selection list, or selection order requires a new activation. Keep the verified selection command for later restarts; Railway can replay a deployment's historical command even after the service setting changes.

To replace a separately installed Slack companion at the same activation, add `--select-bundled-plugin slack` immediately after `--select-bundled-plugin acpx`. Both packages then come from the image and its approved dependency lockfile. Preserve Slack configuration and channel state, and verify both runtime installation paths and versions after readiness.

Both direct npm commands and OpenClaw-managed installs keep disposable download caches in `/tmp/npm`; the installer derives this path from `XDG_CACHE_HOME=/tmp` unless an operation supplies its own cache directory. Recovery captures, published native artifacts, and plugin state remain on `/data`.

## Review the release

- Release notes: <https://github.com/openclaw/openclaw/releases>. The npm
  package carries the same `CHANGELOG.md` and the docs for that exact version:
  `npm pack openclaw@<version> && tar xzf openclaw-<version>.tgz package/CHANGELOG.md package/docs`.
- Look for config migrations, retired keys, database schema changes, Node
  version changes, and anything under "Upgrading very old versions".
- Pick stable releases (`latest`). Avoid `-beta` tags. OpenClaw also publishes
  an `extended-stable` line if you prefer a slower cadence.

## Update the pins

Dependabot opens a PR for new image tags weekly (`.github/dependabot.yml`), and
updates tag and digest together. To do it by hand:

```bash
version=2026.9.9   # example
docker buildx imagetools inspect "ghcr.io/openclaw/openclaw:$version" --format '{{json .Manifest}}' | jq -r .digest
# edit Dockerfile: FROM ghcr.io/openclaw/openclaw:<version>@sha256:<digest>
```

Update the source revision and archive checksum in the build stage at the same time, then verify the capture patch against the new source. The Tailscale binaries have their own `FROM … AS tailscale` line; see [Tailscale upgrades](#tailscale-upgrades).

## Build and validate

CI (`.github/workflows/ci.yml`) builds the image and runs `tests/image.test.sh`
against it on every PR. Among other things, it checks that `openclaw --version`
inside the built image equals the `FROM` tag, that a fresh volume boots, that an
existing volume survives a restart, and that auth, proxy attribution, the health
relay, and the security audit still behave. With the optional
`TAILSCALE_TEST_AUTHKEY` repository secret (a reusable, ephemeral auth key), it
also logs a node in to your tailnet and checks Tailscale Serve end to end;
Dependabot pull requests don't receive secrets, so they run the core tier only.
Don't merge on red.

To test an upgrade against a copy of real state, restore an OpenClaw backup
archive (step 5) into a local Docker volume and start the new image on it.

## Back up

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

## Deploy

Merge the PR. On first activation of the new build, OpenClaw's entrypoint runs `openclaw doctor --fix`
under exclusive state ownership before the Gateway starts, which applies config
and database migrations. Before changing a database schema, Doctor saves
`<database>.pre-startup-migration-<id>.bak` copies beside the originals. The
health check allows 600 seconds for Doctor and Gateway startup together.

Test upgrades against retained state before merging. On Railway, the 2026.10.5 upgrade spent over eight minutes in Doctor inspecting plugins and databases, then exceeded the previous 600-second health-check window during Gateway startup. A successful fresh-volume test does not verify this path. Check the full deployment's startup duration and require `/startupz` to return 200 within the configured window.

The initial recovery deployment took 10 minutes 9 seconds from container start to Gateway readiness: Doctor used 7 minutes 48 seconds and Gateway startup used about 99 seconds. `HOME=/data/home` put disposable SQLite inspection snapshots on the slow persistent volume. Setting `XDG_CACHE_HOME=/tmp` reduced the next full boot to 6 minutes 21 seconds; a diagnostic repeat took 7 minutes 34 seconds. Both passed `/startupz`, and the timeout returned to 600 seconds. A controlled five-snapshot test took 32.7 seconds on the persistent volume and 3.1 seconds in `/tmp`, with matching row counts and successful integrity checks.

The earlier hashing and image-activation changes reduced first activation to 6 minutes 37 seconds (including 4 minutes 7 seconds in Doctor) and a same-image restart to approximately 3 minutes 23 seconds. That restart still copied ordinary plugin dependencies onto the persistent volume. The current patch moves those disposable execution copies to temporary storage; published native artifacts retain durable storage. Measure the complete deployment against retained state after applying the patch, including a same-image restart. A passing fresh-volume test cannot establish production startup performance.

Earlier phase tracing identified repeated plugin dependency capture and hashing, tracked by [OpenClaw issue #166526](https://github.com/openclaw/openclaw/issues/166526). This work is separate from schema migrations. The template patch retains source verification, independent plugin instance ownership, and recovery capture before mutation. Do not describe the entire Doctor duration as migration work or treat a longer timeout as a performance fix.

If Doctor can't migrate safely, the container exits with code **78** and Railway
keeps restarting it. Don't delete state or lock files; see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#exit-code-78).

## Verify

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
  doesn't track. Change the version and both checksums, copied from the
  release's checksums file (for `gh`:
  `gh release download v<version> -R cli/cli -p 'gh_*_checksums.txt'`). The
  build fails if a checksum doesn't match.
- **Claude Code**: Dependabot proposes updates to `tools/package-lock.json`;
  merging one redeploys.
- **Codex**: follows OpenClaw's own pin, so it moves with OpenClaw upgrades.
- **Debian packages** (`jq`, `tmux`, ImageMagick): not pinned; every rebuild
  installs Debian's current security updates. Redeploy periodically to pick
  them up.
- **Homebrew**: the `Dockerfile` pins the seed copied onto a new volume. An
  existing volume's Homebrew updates itself and ignores the seed.

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
