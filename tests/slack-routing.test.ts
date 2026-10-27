import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { verifyRuntimeMetadata, verifyRuntimeRegistration, verifySourceIdentity } from "../scripts/check-slack-routing.ts";

function fixture(run: (root: string, patch: string, release: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "routing-upgrade-test-"));
  try {
    mkdirSync(join(root, "dist/extensions/slack"), { recursive: true });
    writeFileSync(join(root, "dist/extensions/slack/package.json"), JSON.stringify({ version: "1.0.0" }));
    mkdirSync(join(root, "dist/extensions/acpx"), { recursive: true });
    writeFileSync(join(root, "dist/extensions/acpx/package.json"), JSON.stringify({ version: "1.0.0" }));
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.0", dependencies: { zod: "4.6.6" } }));
    mkdirSync(join(root, "node_modules/zod"), { recursive: true });
    writeFileSync(join(root, "node_modules/zod/package.json"), JSON.stringify({ name: "zod", version: "4.6.6" }));
    for (const [name, version] of [["undici", "8.12.3"], ["express", "5.2.1"], ["express/node_modules/body-parser", "2.4.0"]]) {
      mkdirSync(join(root, "node_modules", name), { recursive: true });
      writeFileSync(join(root, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
    }
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

test("installs builder dependencies after patching the source and before compiling it", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  const sourcePatch = dockerfile.indexOf("git apply /tmp/openclaw-plugin-capture.patch");
  const routingPatch = dockerfile.indexOf("git apply /tmp/openclaw-slack-routing.patch");
  const install = dockerfile.indexOf("pnpm install --frozen-lockfile");
  const tests = dockerfile.indexOf("RUN pnpm test");
  assert(sourcePatch >= 0 && routingPatch >= 0 && install >= 0 && tests >= 0);
  assert(install > sourcePatch && install > routingPatch, "The builder must install the patched lockfile.");
  assert(install < tests, "The source tests and compiler must use the patched dependencies.");
});

test("checks the builder's resolved Zod before a runtime build exists", () => {
  fixture((root) => {
    const script = fileURLToPath(new URL("../scripts/check-slack-routing.ts", import.meta.url));
    rmSync(join(root, "dist"), { recursive: true });
    execFileSync(process.execPath, [script, "dependencies", root], { stdio: "pipe" });
    writeFileSync(join(root, "node_modules/zod/package.json"), JSON.stringify({ name: "zod", version: "4.6.5" }));
    assert.throws(() => execFileSync(process.execPath, [script, "dependencies", root], { stdio: "pipe" }), /approved security fix/);
  });
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

test("rejects an image that omits ACPX and leaves a retained installation in charge", () => {
  fixture((root, patch) => {
    rmSync(join(root, "dist/extensions/acpx"), { recursive: true });
    assert.throws(() => verifyRuntimeMetadata(root, patch), /acpx.*package.json/);
  });
});

test("rejects ACPX built from a different host version", () => {
  fixture((root, patch) => {
    writeFileSync(join(root, "dist/extensions/acpx/package.json"), JSON.stringify({ version: "0.9.0" }));
    assert.throws(() => verifyRuntimeMetadata(root, patch), /matched ACPX/);
  });
});

test("rejects inherited host dependencies that differ from the patched source lock", () => {
  fixture((root, patch) => {
    writeFileSync(join(root, "node_modules/zod/package.json"), JSON.stringify({ name: "zod", version: "4.6.5" }));
    assert.throws(() => verifyRuntimeMetadata(root, patch), /host Zod dependency/);
  });
});

for (const [dependency, version, message] of [
  ["undici", "8.11.2", /host Undici dependency/],
  ["express/node_modules/body-parser", "2.3.0", /Express body-parser dependency/],
] as const) {
  test(`rejects the vulnerable installed ${dependency} dependency`, () => {
    fixture((root, patch) => {
      writeFileSync(join(root, "node_modules", dependency, "package.json"), JSON.stringify({ version }));
      assert.throws(() => verifyRuntimeMetadata(root, patch), message);
    });
  });
}

test("replaces companion dependency trees without retaining release-only packages", () => {
  fixture((root) => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const replacement = dockerfile.match(/    for plugin in slack acpx; do \\\n[\s\S]*?    done;/)?.[0];
    assert(replacement, "The image must install both companion dependency trees.");
    const dependencies = join(root, "production-dependencies");
    for (const plugin of ["slack", "acpx"]) {
      const source = join(dependencies, `${plugin}-production-dependencies`);
      mkdirSync(join(source, "node_modules/current"), { recursive: true });
      writeFileSync(join(source, "node_modules/current/package.json"), "{}");
      writeFileSync(join(source, "package-lock.json"), "{}");
      mkdirSync(join(root, `dist/extensions/${plugin}/node_modules/stale`), { recursive: true });
      writeFileSync(join(root, `dist/extensions/${plugin}/node_modules/stale/package.json`), "{}");
    }
    execFileSync("sh", ["-eu", "-c", replacement.replaceAll("/tmp/", `${dependencies}/`)], { cwd: root });
    for (const plugin of ["slack", "acpx"]) {
      assert.equal(readFileSync(join(root, `dist/extensions/${plugin}/node_modules/current/package.json`), "utf8"), "{}");
      assert.throws(() => readFileSync(join(root, `dist/extensions/${plugin}/node_modules/stale/package.json`)), /ENOENT/);
    }
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
  assert.match(dockerfile, /new Set\(\[\.\.\.require\("node:fs"\)\.readdirSync\("\/tmp\/release-extensions"\), "slack", "acpx"\]\)/);
  assert.match(dockerfile, /generateNpmPackageLock\(directory, \{ installStrategy: "shallow" \}\)/);
  assert.match(dockerfile, /for plugin in slack acpx; do/);
  assert.match(dockerfile, /cp -a "\/tmp\/\$plugin-production-dependencies\/node_modules" "dist\/extensions\/\$plugin\/node_modules"/);
  assert.match(dockerfile, /check-slack-routing\.ts runtime \/app \/etc\/openclaw-slack-routing\.patch/);
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


test("keeps source regression artifacts outside the production build ancestry", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  const parents = new Map([...dockerfile.matchAll(/^FROM (\S+) AS (\S+)$/gm)].map((match) => [match[2], match[1]]));
  assert.equal(parents.get("openclaw-source-tests"), "openclaw-source");
  assert.equal(parents.get("openclaw-build"), "openclaw-source");
  assert.equal(parents.get("openclaw-production"), "openclaw-build");
  const tests = dockerfile.slice(dockerfile.indexOf("FROM openclaw-source AS openclaw-source-tests"), dockerfile.indexOf("FROM openclaw-source AS openclaw-build"));
  assert.match(tests, /RUN pnpm test/);
  assert.match(tests, /doctor-contract-registry\.custody\.test\.ts/);
  assert.match(tests, /vitest\.extension-slack\.config\.ts/);
});

test("requires source regressions before image verification and stops if they fail", () => {
  fixture((root) => {
    const script = readFileSync(new URL("./image.test.sh", import.meta.url), "utf8");
    const start = script.indexOf('if [ "${SKIP_BUILD:-0}" != 1 ]; then');
    assert(start >= 0);
    const end = script.indexOf("\nfi", start);
    assert(end > start);
    const block = script.slice(start, end + 3);
    const binaries = join(root, "binaries");
    mkdirSync(binaries);
    writeFileSync(join(binaries, "docker"), [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$DOCKER_TEST_COMMANDS"',
      'if [ "$FAIL_SOURCE_TESTS" = 1 ]; then',
      '  case "$*" in *"--target openclaw-source-tests"*) exit 42 ;; esac',
      "fi",
    ].join("\n"), { mode: 0o755 });
    const commands = join(root, "docker-commands");
    const environment = { ...process.env, PATH: binaries + delimiter + process.env.PATH, SKIP_BUILD: "0", DOCKER_TEST_COMMANDS: commands, FAIL_SOURCE_TESTS: "0" };
    const argumentsList = ["-eu", "-c", 'log() { :; }; pass() { :; }; image=fixture-image; ' + block];
    execFileSync("sh", argumentsList, { env: environment, stdio: "pipe" });
    const expected = ["build --progress=plain --target openclaw-source-tests .", "build --progress=plain -t fixture-image ."];
    assert.deepEqual(readFileSync(commands, "utf8").trim().split("\n"), expected);
    rmSync(commands);
    assert.throws(() => execFileSync("sh", argumentsList, { env: { ...environment, FAIL_SOURCE_TESTS: "1" }, stdio: "pipe" }));
    assert.deepEqual(readFileSync(commands, "utf8").trim().split("\n"), [expected[0]]);
  });
});
