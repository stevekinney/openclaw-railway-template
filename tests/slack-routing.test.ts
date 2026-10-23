import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyRuntimeMetadata, verifyRuntimeRegistration, verifySourceIdentity } from "../scripts/check-slack-routing.ts";

function fixture(run: (root: string, patch: string, release: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "routing-upgrade-test-"));
  try {
    mkdirSync(join(root, "dist/extensions/slack"), { recursive: true });
    writeFileSync(join(root, "dist/extensions/slack/package.json"), JSON.stringify({ version: "1.0.0" }));
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
    const patch = join(root, "routing.patch");
    writeFileSync(patch, "complete routing patch");
    writeFileSync(join(root, "dist/build-info.json"), JSON.stringify({ version: "1.0.0", slackRoutingContractVersion: 1, slackRoutingPatchDigest: createHash("sha256").update(readFileSync(patch)).digest("hex") }));
    const release = join(root, "release.json");
    writeFileSync(release, JSON.stringify({ version: "1.0.0", commit: "a".repeat(40) }));
    run(root, patch, release);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepts a source build matching the pinned release", () => {
  fixture((root, _patch, release) => verifySourceIdentity(root, release, "a".repeat(40)));
});

test("rejects a release upgrade that still builds the previous source", () => {
  fixture((root, _patch, release) => {
    assert.throws(() => verifySourceIdentity(root, release, "b".repeat(40)), /source pin/);
  });
});

test("rejects source and image version disagreement", () => {
  fixture((root, _patch, release) => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.0.0" }));
    assert.throws(() => verifySourceIdentity(root, release, "a".repeat(40)), /versions differ/);
  });
});

test("accepts runtime metadata identifying the exact companion patch", () => {
  fixture((root, patch) => verifyRuntimeMetadata(root, patch));
});

test("rejects an image without the routing contract", () => {
  fixture((root, patch) => {
    writeFileSync(join(root, "dist/build-info.json"), JSON.stringify({ version: "1.0.0" }));
    assert.throws(() => verifyRuntimeMetadata(root, patch), /routing contract/);
  });
});

test("rejects an image built with a different routing patch", () => {
  fixture((root, patch) => {
    writeFileSync(patch, "a newer patch");
    assert.throws(() => verifyRuntimeMetadata(root, patch));
  });
});

test("pins an immutable patch and retains the upgrade gates", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /ADD --checksum=sha256:[a-f0-9]{64} https:\/\/raw\.githubusercontent\.com\/stevekinney\/openclaw-plugin-slack-workspace\/[a-f0-9]{40}\/docs\/openclaw-routing\.patch/);
  assert.match(dockerfile, /git apply --check \/tmp\/openclaw-slack-routing\.patch/);
  assert.match(dockerfile, /COPY --from=openclaw-build --chmod=0644 \/tmp\/openclaw-slack-routing\.patch/);
  assert.match(dockerfile, /check-slack-routing\.ts identity \/app \/tmp\/release-build-info\.json/);
  assert.match(dockerfile, /hooks\.resolve-inbound-route\.test\.ts/);
  assert.match(dockerfile, /vitest\.extension-slack\.config\.ts/);
  assert.match(dockerfile, /new Set\(\[\.\.\.require\("node:fs"\)\.readdirSync\("\/tmp\/release-extensions"\), "slack"\]\)/);
  assert.match(dockerfile, /generateNpmPackageLock\(directory, \{ installStrategy: "shallow" \}\)/);
  assert.match(dockerfile, /cp -a \/tmp\/slack-production-dependencies\/node_modules dist\/extensions\/slack\/node_modules/);
  assert.match(dockerfile, /check-slack-routing\.ts runtime \/app \/etc\/openclaw-railway\/openclaw-slack-routing\.patch/);
});


test("does not accept a CLI success without executing runtime registration", () => {
  fixture((root) => {
    writeFileSync(join(root, "openclaw.mjs"), 'console.log(JSON.stringify({plugin: {status: "loaded"}}));');
    assert.throws(() => verifyRuntimeRegistration(root), /registration.json/);
  });
});


test("rejects an upgrade that stops shipping the matched Slack channel", () => {
  fixture((root) => {
    rmSync(join(root, "dist/extensions/slack"), { recursive: true });
    assert.throws(() => verifyRuntimeRegistration(root), /slack.*package.json/);
  });
});
