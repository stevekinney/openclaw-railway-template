#!/bin/sh
# Sourced by image.test.sh; verifies image versions and rebuilt artifact admission.
# shellcheck disable=SC2016
: "${image:?}"

run_image_admission_checks() {
  log "versions"
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
