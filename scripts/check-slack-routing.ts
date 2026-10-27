import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

const BUNDLED_PLUGIN_IDS = ["acpx", "slack", "lobster", "firecrawl", "exa", "typesafe"] as const;
const COMPOSED_DEPENDENCIES = ["@agentclientprotocol/claude-agent-acp", "@agentclientprotocol/codex-acp", "@clawdbot/lobster", "@slack/bolt", "@slack/types", "@slack/web-api", "acpx", "get-east-asian-width", "smol-toml"];

function object(value: unknown, description: string): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), `Expected object: ${description}`);
  return value as Record<string, unknown>;
}

/** Permit only the pinned composition's root importer changes, preserving all resolutions. */
export function verifyCompositionLock(
  before: { environment: string | null; application: unknown },
  after: { environment: string | null; application: unknown },
  manifest: unknown,
): void {
  assert.equal(after.environment, before.environment, "Composition changed the package-manager document");
  const original = object(before.application, "original application lock");
  const composed = object(after.application, "composed application lock");
  const originalFields = { ...original };
  const composedFields = { ...composed };
  delete originalFields.importers;
  delete composedFields.importers;
  assert.deepStrictEqual(composedFields, originalFields, "Composition changed application resolutions or metadata");
  const originalImporters = object(original.importers, "original importers");
  const composedImporters = object(composed.importers, "composed importers");
  const originalOthers = { ...originalImporters };
  const composedOthers = { ...composedImporters };
  delete originalOthers["."];
  delete composedOthers["."];
  assert.deepStrictEqual(composedOthers, originalOthers, "Composition changed another importer");
  const originalRoot = object(originalImporters["."], "original root importer");
  const composedRoot = object(composedImporters["."], "composed root importer");
  const originalMetadata = { ...originalRoot };
  const composedMetadata = { ...composedRoot };
  for (const section of ["dependencies", "devDependencies"]) {
    delete originalMetadata[section];
    delete composedMetadata[section];
  }
  assert.deepStrictEqual(composedMetadata, originalMetadata, "Composition changed root importer metadata");
  const originalDependencies = object(originalRoot.dependencies ?? {}, "original dependencies");
  const composedDependencies = object(composedRoot.dependencies, "composed dependencies");
  const additions = Object.keys(composedDependencies).filter((name) => !Object.hasOwn(originalDependencies, name));
  assert.deepStrictEqual(additions.toSorted(), COMPOSED_DEPENDENCIES.toSorted(), "Composition changed unexpected root additions");
  for (const [name, entry] of Object.entries(originalDependencies)) {
    assert.deepStrictEqual(composedDependencies[name], entry, `Composition changed existing dependency ${name}`);
  }
  const declaredDependencies = object(object(manifest, "composed package manifest").dependencies, "declared dependencies");
  const snapshots = object(original.snapshots, "original snapshots");
  for (const name of additions) {
    const entry = object(composedDependencies[name], `added dependency ${name}`);
    assert.equal(typeof declaredDependencies[name], "string", `Composition did not declare ${name}`);
    assert.equal(entry.specifier, declaredDependencies[name], `Composition changed declared version ${name}`);
    assert.equal(typeof entry.version, "string", `Composition omitted the locked version ${name}`);
    assert(Object.hasOwn(snapshots, `${name}@${entry.version}`), `Composition introduced a new resolution for ${name}`);
  }
  const originalDevelopment = { ...object(originalRoot.devDependencies ?? {}, "original development dependencies") };
  if (Object.hasOwn(originalDevelopment, "acpx")) {
    assert.deepStrictEqual(composedDependencies.acpx, originalDevelopment.acpx, "Composition changed the ACPX dependency transfer");
    delete originalDevelopment.acpx;
  }
  assert.deepStrictEqual(composedRoot.devDependencies ?? {}, originalDevelopment, "Composition changed development dependencies");
}

function readObject(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert(value && typeof value === "object" && !Array.isArray(value), `Expected object: ${path}`);
  return value as Record<string, unknown>;
}

/** Refuse an image upgrade that still rebuilds a different upstream source revision. */
export function verifySourceIdentity(root: string, releaseInformation: string, commit: string): void {
  const release = readObject(releaseInformation);
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(release.commit, commit, "Update the OpenClaw source pin and rebase both patches for this release.");
  assert.equal(readObject(join(root, "package.json")).version, release.version, "Source and release versions differ.");
}

/** Verify that the built image identifies the complete, immutable companion patch. */
export function verifyRuntimeMetadata(root: string, patch: string): void {
  const information = readObject(join(root, "dist/build-info.json"));
  assert.equal(information.version, readObject(join(root, "package.json")).version);
  assert.equal(information.slackRoutingContractVersion, 1, "The image lost its Slack routing contract.");
  assert.equal(information.slackRoutingPatchDigest, createHash("sha256").update(readFileSync(patch)).digest("hex"));
  for (const pluginId of BUNDLED_PLUGIN_IDS) {
    assert.equal(readObject(join(root, "dist/extensions", pluginId, "package.json")).version, information.version, `The image must contain its matched ${pluginId} runtime.`);
  }
  verifyInstalledDependencies(root);
}

/** Check the resolved dependency before compilation as well as in the final image. */
export function verifyInstalledDependencies(root: string): void {
  const require = createRequire(join(root, "package.json"));
  assert.equal(readObject(require.resolve("zod/package.json")).version, "4.6.6", "The host Zod dependency must include the approved security fix.");
  assert.equal(readObject(require.resolve("undici/package.json")).version, "8.12.3", "The host Undici dependency must include the approved security fixes.");
  const expressRequire = createRequire(require.resolve("express/package.json"));
  assert.equal(readObject(expressRequire.resolve("body-parser/package.json")).version, "2.4.0", "The Express body-parser dependency must include the approved security fix.");
}

/** Load an isolated plugin through the real host to verify its runtime routing API. */
export function verifyRuntimeRegistration(root: string): void {
  const directory = mkdtempSync(join(tmpdir(), "slack-routing-contract-"));
  try {
    const pluginDirectory = join(directory, "plugin");
    mkdirSync(pluginDirectory, { mode: 0o700 });
    const receipt = join(directory, "registration.json");
    writeFileSync(join(pluginDirectory, "package.json"), JSON.stringify({ name: "routing-contract-check", type: "module", openclaw: { extensions: ["./index.mjs"] } }));
    writeFileSync(join(pluginDirectory, "openclaw.plugin.json"), JSON.stringify({ id: "routing-contract-check", name: "Routing contract check", configSchema: { type: "object", additionalProperties: false, properties: {} } }));
    writeFileSync(join(pluginDirectory, "index.mjs"), `
      import assert from 'node:assert/strict';
      import { writeFileSync } from 'node:fs';
      export default { id: 'routing-contract-check', register(api) {
        assert.equal(api.registrationMode, 'full');
        assert.equal(api.runtime.channel.routing.inboundRouteContractVersion, 1);
        assert.equal(typeof api.runtime.channel.routing.resolveInboundRoute, 'function');
        assert.equal(typeof api.registerInteractiveHandler, 'function');
        api.on('resolve_inbound_route', async () => undefined);
        api.registerInteractiveHandler({ channel: 'slack', namespace: 'routing-contract-check', handler: async () => ({ handled: true }) });
        writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ contractVersion: 1 }));
      } };
    `);
    const bundledRoots = Object.fromEntries(BUNDLED_PLUGIN_IDS.map((pluginId) => [pluginId, join(root, "dist/extensions", pluginId)]));
    for (const pluginId of BUNDLED_PLUGIN_IDS) assert.equal(readObject(join(bundledRoots[pluginId], "package.json")).version, readObject(join(root, "package.json")).version, `The image must contain its matched ${pluginId} channel.`);
    const configuration = join(directory, "configuration.json");
    writeFileSync(configuration, JSON.stringify({ channels: { slack: { enabled: true, botToken: "xoxb-test", appToken: "xapp-test" } }, plugins: { allow: ["routing-contract-check", ...BUNDLED_PLUGIN_IDS], load: { paths: [pluginDirectory, ...BUNDLED_PLUGIN_IDS.map((pluginId) => bundledRoots[pluginId])] }, entries: { "routing-contract-check": { enabled: true }, ...Object.fromEntries(BUNDLED_PLUGIN_IDS.map((pluginId) => [pluginId, { enabled: true }])) } } }));
    // Registration must not contact Slack or any other provider during an image build.
    const guard = join(directory, "no-network.mjs");
    writeFileSync(guard, `
      import net from 'node:net';
      import tls from 'node:tls';
      import dns from 'node:dns';
      import dgram from 'node:dgram';
      import { syncBuiltinESMExports } from 'node:module';
      const denied = () => { throw new Error('Network access during routing contract registration'); };
      const connect = net.Socket.prototype.connect;
      net.Socket.prototype.connect = function (...args) {
        let value = args[0];
        if (Array.isArray(value)) value = value[0];
        if ((typeof value === 'string' && value.startsWith('/')) || (value && typeof value === 'object' && typeof value.path === 'string')) return connect.apply(this, args);
        return denied();
      };
      globalThis.fetch = denied;
      tls.connect = denied;
      dgram.Socket.prototype.send = denied;
      for (const surface of [dns, dns.promises]) for (const name of Object.keys(surface)) if (name === 'lookup' || name === 'lookupService' || name.startsWith('resolve') || name === 'reverse') surface[name] = denied;
      syncBuiltinESMExports();
    `);
    const environment = { ...process.env, OPENCLAW_HOME: directory, OPENCLAW_STATE_DIR: join(directory, "state"), OPENCLAW_CONFIG_PATH: configuration, NODE_OPTIONS: `--import=${guard}` };
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import net from 'node:net';
      import dns from 'node:dns';
      assert.throws(() => fetch('https://example.invalid'), /Network access/);
      assert.throws(() => net.connect({host: 'example.invalid', port: 443}), /Network access/);
      assert.throws(() => dns.lookup('example.invalid', () => {}), /Network access/);
    `], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    const probe = join(directory, "full-registration.mjs");
    writeFileSync(probe, `
      import { readFileSync } from 'node:fs';
      import { loadAndActivateRootPluginRegistry } from ${JSON.stringify(pathToFileURL(join(root, "dist/plugins/loader.js")).href)};
      const registry = await loadAndActivateRootPluginRegistry({ cache: false, config: JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8')) });
      const selected = (registry.plugins ?? []).filter((plugin) => ['routing-contract-check', 'acpx', 'slack', 'lobster', 'firecrawl', 'exa', 'typesafe'].includes(plugin.id));
      process.stdout.write('OPENCLAW_ROUTING_FULL_REGISTRATION=' + JSON.stringify(selected.map(({ id, status, activated, source, version }) => ({ id, status, activated, source, version }))));
    `);
    const output = execFileSync(process.execPath, [probe], {
      cwd: root,
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const marker = "OPENCLAW_ROUTING_FULL_REGISTRATION=";
    const markerPosition = output.lastIndexOf(marker);
    assert(markerPosition >= 0, "The full registration probe did not return its result marker.");
    const registration: unknown = JSON.parse(output.slice(markerPosition + marker.length));
    assert(Array.isArray(registration), "The full registration probe did not return plugin records.");
    type RegistrationRecord = {
      id: string;
      status?: unknown;
      activated?: unknown;
      source?: unknown;
      version?: unknown;
    };
    const records: unknown[] = registration;
    for (const pluginId of ["routing-contract-check", ...BUNDLED_PLUGIN_IDS]) {
      const plugin = records.find((candidate): candidate is RegistrationRecord =>
        candidate !== null && typeof candidate === "object" && "id" in candidate &&
        typeof candidate.id === "string" && candidate.id === pluginId,
      );
      assert(plugin, `The full registration probe did not return ${pluginId}.`);
      assert.equal(plugin.status, "loaded", `${pluginId} failed full runtime registration.`);
      assert(plugin.activated === true, `${pluginId} was inspected but not activated.`);
      if (BUNDLED_PLUGIN_IDS.includes(pluginId as (typeof BUNDLED_PLUGIN_IDS)[number])) {
        const bundledRoot = bundledRoots[pluginId as (typeof BUNDLED_PLUGIN_IDS)[number]];
        assert("source" in plugin && typeof plugin.source === "string");
        assert(realpathSync(plugin.source).startsWith(realpathSync(bundledRoot) + sep), `${pluginId} must load from the rebuilt image, not a retained archive.`);
        assert.equal(plugin.version, readObject(join(root, "package.json")).version);
      }
    }
    assert.equal(readObject(receipt).contractVersion, 1, "Runtime registration was not executed.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [mode, root, input] = process.argv.slice(2);
  const usage = "Usage: node check-slack-routing.ts identity|runtime ROOT INPUT, or dependencies ROOT";
  assert(root, usage);
  if (mode === "dependencies") verifyInstalledDependencies(root);
  else if (mode === "identity") {
    assert(input, usage);
    verifySourceIdentity(root, input, process.env.GIT_COMMIT ?? "");
  } else {
    assert.equal(mode, "runtime");
    assert(input, usage);
    verifyRuntimeMetadata(root, input);
    verifyRuntimeRegistration(root);
  }
  console.log(`OpenClaw ${mode} verification passed.`);
}
