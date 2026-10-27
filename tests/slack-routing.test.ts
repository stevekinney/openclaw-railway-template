import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { composeLockfileRootImporter, verifyCompositionLock, verifyInstalledDependencies, verifyRuntimeMetadata, verifyRuntimeRegistration, verifySourceIdentity } from "../scripts/check-slack-routing.ts";

const BUNDLED_PLUGIN_IDS = ["acpx", "slack", "lobster", "firecrawl", "exa", "typesafe"] as const;

function fixture(run: (root: string, patch: string, release: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "routing-upgrade-test-"));
  try {
    for (const pluginId of BUNDLED_PLUGIN_IDS) {
      mkdirSync(join(root, "dist/extensions", pluginId), { recursive: true });
      writeFileSync(join(root, "dist/extensions", pluginId, "package.json"), JSON.stringify({ version: "1.0.0" }));
    }
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.0", type: "module", dependencies: { zod: "4.6.6" } }));
    mkdirSync(join(root, "node_modules/zod"), { recursive: true });
    writeFileSync(join(root, "node_modules/zod/package.json"), JSON.stringify({ name: "zod", version: "4.6.6" }));
    writeFileSync(join(root, "node_modules/zod/index.js"), "");
    for (const owner of ["ui", "packages/markdown-core", "packages/mermaid-renderer"]) {
      mkdirSync(join(root, owner), { recursive: true });
      writeFileSync(join(root, owner, "package.json"), JSON.stringify({ name: owner, version: "1.0.0" }));
    }
    const dependencies = [
      ["node_modules/undici", "undici", "8.12.3"],
      ["node_modules/express", "express", "5.2.1"],
      ["node_modules/express/node_modules/body-parser", "body-parser", "2.4.0"],
      ["node_modules/express/node_modules/qs", "qs", "6.16.1"],
      ["ui/node_modules/dompurify", "dompurify", "3.4.17"],
      ["ui/node_modules/markdown-it", "markdown-it", "15.0.3"],
      ["packages/markdown-core/node_modules/markdown-it", "markdown-it", "15.0.3"],
      ["packages/mermaid-renderer/node_modules/dompurify", "dompurify", "3.4.17"],
      ["packages/mermaid-renderer/node_modules/mermaid", "mermaid", "12.1.0"],
      ["packages/mermaid-renderer/node_modules/mermaid/node_modules/dompurify", "dompurify", "3.4.17"],
      ["packages/mermaid-renderer/node_modules/mermaid/node_modules/katex", "katex", "0.18.2"],
    ] as const;
    for (const [path, name, version] of dependencies) {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, path, "package.json"), JSON.stringify({ name, version }));
      writeFileSync(join(root, path, "index.js"), "");
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
  const dependencyCheck = dockerfile.indexOf("check-slack-routing.ts dependencies /app");
  const tests = dockerfile.indexOf("RUN pnpm test");
  assert(sourcePatch >= 0 && routingPatch >= 0 && install >= 0 && dependencyCheck >= 0 && tests >= 0);
  assert(install > sourcePatch && install > routingPatch, "The builder must install the patched lockfile.");
  assert(dependencyCheck > install && dependencyCheck < tests, "The builder must verify installed dependencies before compiling the image.");
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

test("runtime verification does not depend on source-only UI dependency links", () => {
  fixture((root, patch) => {
    rmSync(join(root, "ui"), { recursive: true, force: true });
    verifyRuntimeMetadata(root, patch);
  });
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
    assert.throws(() => verifyRuntimeMetadata(root, patch), /matched acpx runtime/i);
  });
});

test("rejects inherited host dependencies that differ from the patched source lock", () => {
  fixture((root, patch) => {
    writeFileSync(join(root, "node_modules/zod/package.json"), JSON.stringify({ name: "zod", version: "4.6.5" }));
    assert.throws(() => verifyRuntimeMetadata(root, patch), /host Zod dependency/);
  });
});

for (const [dependency, version, message] of [
  ["node_modules/express/node_modules/qs", "6.16.0", /Express qs dependency/],
  ["ui/node_modules/dompurify", "3.4.16", /UI DOMPurify dependency/],
  ["ui/node_modules/markdown-it", "15.0.2", /UI markdown-it dependency/],
  ["packages/markdown-core/node_modules/markdown-it", "15.0.2", /Markdown core dependency/],
  ["packages/mermaid-renderer/node_modules/dompurify", "3.4.16", /Mermaid renderer DOMPurify dependency/],
  ["packages/mermaid-renderer/node_modules/mermaid/node_modules/dompurify", "3.4.16", /Mermaid DOMPurify dependency/],
  ["packages/mermaid-renderer/node_modules/mermaid/node_modules/katex", "0.16.47", /Mermaid KaTeX dependency/],
  ["node_modules/undici", "8.11.2", /host Undici dependency/],
  ["node_modules/express/node_modules/body-parser", "2.3.0", /Express body-parser dependency/],
] as const) {
  test(`rejects the vulnerable installed ${dependency} dependency`, () => {
    fixture((root, patch) => {
      writeFileSync(join(root, dependency, "package.json"), JSON.stringify({ version }));
      assert.throws(() => verifyInstalledDependencies(root), message);
    });
  });
}

test("replaces companion dependency trees without retaining release-only packages", () => {
  fixture((root) => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const replacement = dockerfile.match(/    for plugin in acpx slack lobster firecrawl exa typesafe; do \\\n[\s\S]*?    done;/)?.[0];
    assert(replacement, "The image must install both companion dependency trees.");
    const dependencies = join(root, "production-dependencies");
    for (const plugin of BUNDLED_PLUGIN_IDS) {
      const source = join(dependencies, `${plugin}-production-dependencies`);
      mkdirSync(join(source, "node_modules/current"), { recursive: true });
      writeFileSync(join(source, "node_modules/current/package.json"), "{}");
      writeFileSync(join(source, "package-lock.json"), "{}");
      mkdirSync(join(root, `dist/extensions/${plugin}/node_modules/stale`), { recursive: true });
      writeFileSync(join(root, `dist/extensions/${plugin}/node_modules/stale/package.json`), "{}");
    }
    execFileSync("sh", ["-eu", "-c", replacement.replaceAll("/tmp/", `${dependencies}/`)], { cwd: root });
    for (const plugin of BUNDLED_PLUGIN_IDS) {
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
  assert.match(dockerfile, /new Set\(\[\.\.\.require\("node:fs"\)\.readdirSync\("\/tmp\/release-extensions"\), "acpx", "slack", "lobster", "firecrawl", "exa", "typesafe"\]\)/);
  assert.match(dockerfile, /generateNpmPackageLock\(directory, \{ installStrategy: "shallow" \}\)/);
  assert.match(dockerfile, /for plugin in acpx slack lobster firecrawl exa typesafe; do/);
  assert.match(dockerfile, /check-slack-routing\.ts compose-lockfile \/app/);
  assert.match(readFileSync(new URL("../scripts/check-slack-routing.ts", import.meta.url), "utf8"), /preparePackageBundledPlugins\(root, plugins/);
  assert.doesNotMatch(dockerfile, /pnpm install --lockfile-only/);
  assert.match(dockerfile, /--select-bundled-plugin", "acpx"[\s\S]*--select-bundled-plugin", "typesafe"/);
  assert.match(dockerfile, /cp -a "\/tmp\/\$plugin-production-dependencies\/node_modules" "dist\/extensions\/\$plugin\/node_modules"/);
  assert.match(dockerfile, /check-slack-routing\.ts runtime \/app \/etc\/openclaw-slack-routing\.patch/);
});


test("does not accept activation success without executing runtime registration", () => {
  fixture((root) => {
    for (const plugin of BUNDLED_PLUGIN_IDS) writeFileSync(join(root, "dist/extensions", plugin, "index.js"), "export default {};" );
    mkdirSync(join(root, "dist/plugins"), { recursive: true });
    writeFileSync(join(root, "dist/plugins/loader.js"), `
      export async function loadAndActivateRootPluginRegistry() {
        return { plugins: [
          { id: "routing-contract-check", status: "loaded", activated: true },
          ...${JSON.stringify(BUNDLED_PLUGIN_IDS)}.map((id) => ({ id, status: "loaded", activated: true, source: new URL("dist/extensions/" + id + "/index.js", "file://${root}/").pathname, version: "1.0.0" })),
        ] };
      }
    `);
    assert.throws(() => verifyRuntimeRegistration(root), /registration.json/);
  });
});

test("keeps registration output and writable state outside the plugin source", () => {
  fixture((root) => {
    for (const plugin of BUNDLED_PLUGIN_IDS) {
      writeFileSync(join(root, "dist/extensions", plugin, "index.js"), "export default {};");
    }
    mkdirSync(join(root, "dist/plugins"), { recursive: true });
    writeFileSync(join(root, "dist/plugins/loader.js"), `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';
      export async function loadAndActivateRootPluginRegistry() {
        const configuration = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
      const source = configuration.plugins.load.paths[0];
      for (const writablePath of [process.env.OPENCLAW_STATE_DIR, process.env.OPENCLAW_CONFIG_PATH]) {
        assert(!path.resolve(writablePath).startsWith(path.resolve(source) + path.sep), 'Writable state must not be captured as plugin source.');
      }
      const before = fs.readdirSync(source).toSorted();
      const probe = await import(pathToFileURL(path.join(source, 'index.mjs')));
      probe.default.register({ registrationMode: 'full', runtime: { channel: { routing: { inboundRouteContractVersion: 1, resolveInboundRoute() {} } } }, on() {}, registerInteractiveHandler() {} });
      assert.deepEqual(fs.readdirSync(source).toSorted(), before, 'Registration output must not change the captured source.');
        const version = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(root)}, 'package.json'), 'utf8')).version;
        return { plugins: ${JSON.stringify(BUNDLED_PLUGIN_IDS)}.map((id) => ({ id, status: 'loaded', activated: true, version, source: path.join(${JSON.stringify(root)}, 'dist/extensions', id, 'index.js') })).concat({ id: 'routing-contract-check', status: 'loaded', activated: true }) };
      }
    `);
    verifyRuntimeRegistration(root);
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

function compositionFixture() {
  const additions = ["@agentclientprotocol/claude-agent-acp", "@agentclientprotocol/codex-acp", "@clawdbot/lobster", "@slack/bolt", "@slack/types", "@slack/web-api", "acpx", "get-east-asian-width", "smol-toml"];
  const entry = { specifier: "1.2.3", version: "1.2.3" };
  const original = {
    environment: "package-manager-document",
    application: {
      lockfileVersion: "9.0", settings: { autoInstallPeers: true }, overrides: { qs: "6.16.1" },
      packages: Object.fromEntries(additions.map((name) => [name + "@1.2.3", { resolution: { integrity: "sha512-fixture" } }])),
      snapshots: Object.fromEntries(additions.map((name) => [name + "@1.2.3", {}])),
      importers: {
        ".": { dependencies: { kept: entry }, devDependencies: { acpx: entry, tool: entry } },
        "extensions/acpx": { dependencies: Object.fromEntries(additions.filter((name) => name !== "acpx").map((name) => [name, entry])) },
        "extensions/exa": { dependencies: { kept: entry } },
      },
    },
  };
  const composed = structuredClone(original);
  Object.assign(composed.application.importers["."].dependencies, Object.fromEntries(additions.map((name) => [name, entry])));
  delete (composed.application.importers["."].devDependencies as Partial<typeof composed.application.importers["."]["devDependencies"]>).acpx;
  const manifest = { dependencies: Object.fromEntries(["kept", ...additions].map((name) => [name, "1.2.3"])) };
  return { original, composed, manifest };
}

test("composition validates the application document and the expected root additions", () => {
  const { original, composed, manifest } = compositionFixture();
  verifyCompositionLock(original, composed, manifest);
});

test("composes the root lockfile importer from pinned workspace resolutions", () => {
  const { original, manifest } = compositionFixture();
  const composed = structuredClone(original);
  composeLockfileRootImporter(composed.application, manifest, ["acpx"]);
  verifyCompositionLock(original, composed, manifest);
});

for (const mutation of ["environment", "packages", "snapshots", "settings", "overrides", "importer", "unknown application field", "existing root", "unexpected root addition", "development dependency", "new resolution", "manifest version"]) {
  test(`composition rejects changed ${mutation}`, () => {
    const { original, composed, manifest } = compositionFixture();
    if (mutation === "environment") composed.environment = "different manager";
    if (mutation === "packages") composed.application.packages["acpx@1.2.3"].resolution.integrity = "sha512-substituted";
    if (mutation === "snapshots") composed.application.snapshots["acpx@1.2.3"] = { dependencies: { injected: "9.9.9" } };
    if (mutation === "settings") composed.application.settings.autoInstallPeers = false;
    if (mutation === "overrides") composed.application.overrides.qs = "9.9.9";
    if (mutation === "importer") Object.assign(composed.application.importers, { "unexpected/importer": {} });
    if (mutation === "unknown application field") Object.assign(composed.application, { injected: true });
    if (mutation === "existing root") composed.application.importers["."].dependencies.kept = { specifier: "9.9.9", version: "9.9.9" };
    if (mutation === "unexpected root addition") Object.assign(composed.application.importers["."].dependencies, { injected: { specifier: "1.2.3", version: "1.2.3" } });
    if (mutation === "development dependency") composed.application.importers["."].devDependencies.tool = { specifier: "9.9.9", version: "9.9.9" };
    if (mutation === "new resolution") Object.assign(composed.application.importers["."].dependencies, { acpx: { specifier: "1.2.3", version: "9.9.9" } });
    if (mutation === "manifest version") manifest.dependencies.acpx = "9.9.9";
    assert.throws(() => verifyCompositionLock(original, composed, manifest));
  });
}
