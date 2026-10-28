#!/bin/sh
# Sourced by image.test.sh; verifies image versions and rebuilt artifact admission.
# shellcheck disable=SC2016
: "${image:?}"


# The Gateway without Tailscale: loopback-only, reachable only from inside.
start_gateway() {
  : "${gateway:?}" "${network:?}" "${run_id:?}" "${token:?}" "${hooks_token:?}"
  docker run -d --name "$gateway" --network "$network" -v "$run_id-state:/data" \
    -e OPENCLAW_GATEWAY_TOKEN="$token" -e OPENCLAW_RAILWAY_TEST_WITHOUT_TAILSCALE=1 -e OPENCLAW_DEBUG=1 \
    -e OPENCLAW_RAILWAY_WEBHOOKS=on -e OPENCLAW_HOOKS_TOKEN="$hooks_token" \
    "$image" node openclaw.mjs \
      --select-bundled-plugin acpx --select-bundled-plugin slack \
      --select-bundled-plugin lobster --select-bundled-plugin firecrawl \
      --select-bundled-plugin exa --select-bundled-plugin typesafe \
      gateway --bind loopback --tailscale off --auth token >/dev/null
}

run_image_admission_checks() {
  log "versions"
  check "the default image command selects all six matched stock plugins before Gateway" \
    'docker inspect --format '\''{{json .Config.Cmd}}'\'' "$image" | node -e '\''
      const assert = require("node:assert/strict");
      const command = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      const selected = ["acpx", "slack", "lobster", "firecrawl", "exa", "typesafe"];
      assert.deepEqual(command, ["node", "openclaw.mjs", ...selected.flatMap((id) => ["--select-bundled-plugin", id]), "gateway", "--bind", "loopback", "--tailscale", "serve", "--auth", "token"]);
    '\'''
  pinned_version="$(sed -n 's|^FROM ghcr.io/openclaw/openclaw:\([^@]*\)@sha256:.*|\1|p' Dockerfile)"
  installed_version="$(docker run --rm --entrypoint node "$image" /app/openclaw.mjs --version | sed -n 's/^OpenClaw \([^ ]*\).*/\1/p')"
  check "installed OpenClaw ($installed_version) matches the Dockerfile pin ($pinned_version)" \
    '[ -n "$pinned_version" ] && [ "$pinned_version" = "$installed_version" ]'
  pinned_tailscale="$(sed -n 's|^FROM tailscale/tailscale:v\([^@]*\)@sha256:.* AS tailscale$|\1|p' Dockerfile)"
  installed_tailscale="$(docker run --rm --entrypoint tailscale "$image" version | head -1)"
  check "installed Tailscale ($installed_tailscale) matches the Dockerfile pin ($pinned_tailscale)" \
    '[ -n "$pinned_tailscale" ] && [ "$pinned_tailscale" = "$installed_tailscale" ]'

  patch_digest="$(node -e 'process.stdout.write(require("node:crypto").hash("sha256", require("node:fs").readFileSync("scripts/openclaw-plugin-capture.patch")))')"
  [ "${#patch_digest}" = 64 ] || return 1
  check "activation metadata identifies the exact applied runtime patch" \
    'docker run --rm --entrypoint node "$image" -e '"'"'
      const information = require("/app/dist/build-info.json");
      require("node:assert/strict").equal(information.railwayPatchDigest, process.argv[1]);
    '"'"' "$patch_digest"'
  routing_patch_digest="$(sed -n 's|^ADD --checksum=sha256:\([a-f0-9]*\) https://raw.githubusercontent.com/stevekinney/openclaw-plugin-slack-workspace/.*|\1|p' Dockerfile)"
  [ "${#routing_patch_digest}" = 64 ] || return 1
  check "the image identifies the exact pinned Slack routing patch" \
    'docker run --rm --entrypoint node "$image" -e '"'"'
      const information = require("/app/dist/build-info.json");
      const assert = require("node:assert/strict");
      assert.equal(information.slackRoutingContractVersion, 1);
      assert.equal(information.slackRoutingPatchDigest, process.argv[1]);
    '"'"' "$routing_patch_digest"'
  check "the real host registers a plugin against the Slack routing contract" \
    'docker run --rm --entrypoint node "$image" /usr/local/lib/openclaw-railway/check-slack-routing.ts runtime /app /etc/openclaw-slack-routing.patch'
  check "bundled selection replaces retained stock packages and preserves authored policy" \
    'verify_retained_bundled_plugins'
  check "the image defaults disposable inspection snapshots to container storage" \
    'docker run --rm --entrypoint node "$image" -e '"'"'
      require("node:assert/strict").equal(process.env.XDG_CACHE_HOME, "/tmp");
    '"'"''

  check "runtime contains exactly the rebuilt artifacts and production plugin links" \
    'docker run --rm --entrypoint node "$image" -e '"'"'
      const fs = require("node:fs");
      const assert = require("node:assert/strict");
      const expected = JSON.parse(fs.readFileSync("/app/openclaw-build-files.json", "utf8"));
      const actual = fs.readdirSync("/app/dist", { recursive: true }).toSorted();
      assert.deepEqual(actual, expected);
      for (const file of actual) {
        const pathname = "/app/dist/" + file;
        if (fs.lstatSync(pathname).isSymbolicLink()) assert.ok(fs.existsSync(pathname), "broken production dependency: " + file);
      }
    '"'"''

  check "Control UI assets match the runtime build identity" \
    'docker run --rm --entrypoint node "$image" -e '"'"'
      const fs = require("node:fs");
      const runtime = JSON.parse(fs.readFileSync("/app/dist/build-info.json", "utf8"));
      const html = fs.readFileSync("/app/dist/control-ui/index.html", "utf8");
      const identity = html.match(/data-openclaw-control-ui-build-id="([a-zA-Z0-9._-]+)-[a-f0-9]{64}"/u)?.[1];
      if (!identity || identity !== runtime.buildId) throw new Error("Control UI build identity differs from runtime");
    '"'"''
}

verify_retained_bundled_plugins() {
  docker run --rm -i --network none --user node --tmpfs /data:uid=1000,gid=1000 \
    --entrypoint node "$image" --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const state = '/data/.openclaw';
fs.mkdirSync(state, { recursive: true });
fs.mkdirSync('/data/home', { recursive: true });
const configuration = path.join(state, 'openclaw.json');
const policy = {
  allow: ['exa'], deny: ['lobster'],
  entries: { lobster: { enabled: false }, exa: { enabled: false, config: { webSearch: { baseUrl: 'https://fixture.invalid/search' } } } },
};
fs.writeFileSync(configuration, JSON.stringify({ gateway: { mode: 'local' }, plugins: policy }));
const cli = (...args) => execFileSync(process.execPath, ['/app/openclaw.mjs', ...args], {
  env: { ...process.env, OPENCLAW_CONFIG_PATH: configuration, OPENCLAW_STATE_DIR: state, HOME: '/data/home' },
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
});
const inspect = (id) => JSON.parse(cli('plugins', 'info', id, '--json'));
const previousInstallPaths = new Map();
for (const id of ['lobster', 'exa']) {
  const root = '/tmp/legacy-' + id;
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@openclaw/' + id, version: '2026.9.7', type: 'module', openclaw: { extensions: ['./index.mjs'] } }));
  fs.copyFileSync('/app/dist/extensions/' + id + '/openclaw.plugin.json', path.join(root, 'openclaw.plugin.json'));
  fs.writeFileSync(path.join(root, 'index.mjs'), `export default { id: ${JSON.stringify(id)}, register() {} };`);
  cli('plugins', 'install', root, '--force', '--accept-capabilities', '--no-enable');
  const before = inspect(id);
  assert.equal(before.plugin.version, '2026.9.7');
  assert.ok(before.install.installPath.startsWith(state + '/extensions/'));
  assert.ok(fs.existsSync(before.install.installPath));
  previousInstallPaths.set(id, before.install.installPath);
}
const beforeConfiguration = JSON.parse(fs.readFileSync(configuration, 'utf8'));
cli('plugins', 'install', 'lobster', 'exa', '--no-enable');
assert.deepEqual(JSON.parse(fs.readFileSync(configuration, 'utf8')), beforeConfiguration);
for (const id of ['lobster', 'exa']) {
  const after = inspect(id);
  const bundledRoot = '/app/dist/extensions/' + id;
  assert.equal(after.install.source, 'path');
  assert.equal(after.install.installPath, bundledRoot);
  assert.equal(after.install.sourcePath, bundledRoot);
  assert.equal(after.plugin.version, JSON.parse(fs.readFileSync('/app/package.json', 'utf8')).version);
  assert.ok(after.plugin.source.startsWith(bundledRoot + '/'));
  assert.equal(fs.existsSync(previousInstallPaths.get(id)), false);
}
NODE
}

install_image_worker_probe() {
  : "${gateway:?}"
  # Exercise asynchronous acquisition in the packaged Gateway on its existing
  # restart. The CLI registration probe uses the synchronous loader.
  docker exec "$gateway" as-node node -e '
    const fs = require("node:fs");
    const root = "/data/image-worker-probe";
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(root + "/package.json", JSON.stringify({ name: "image-worker-probe", version: "1.0.0", type: "module", openclaw: { extensions: ["./index.mjs"] } }));
    fs.writeFileSync(root + "/openclaw.plugin.json", JSON.stringify({ id: "image-worker-probe", activation: { onStartup: true }, configSchema: { type: "object", additionalProperties: false, properties: {} } }));
    fs.writeFileSync(root + "/index.mjs", `import { writeFileSync } from "node:fs"; export default { id: "image-worker-probe", register(api) { writeFileSync("/data/.openclaw/image-worker-registration.json", JSON.stringify({ pluginId: api.id, source: import.meta.url })); } };`);
  '
  # This test-authored startup hook is reviewed here; record its capability consent.
  gateway_cli plugins install /data/image-worker-probe --link --force --accept-capabilities >/dev/null
}

check_image_worker_probe() {
  : "${gateway:?}"
  check "the packaged Gateway executes an external plugin captured by its preparation worker" \
    'docker exec "$gateway" as-node node -e '"'"'
      const { pluginId, source } = require("/data/.openclaw/image-worker-registration.json");
      const assert = require("node:assert/strict");
      assert.equal(pluginId, "image-worker-probe");
      assert.match(source, /^file:\/\/\/tmp\/.*\/plugin-preparation-[^/]+\//);
    '"'"''
}
