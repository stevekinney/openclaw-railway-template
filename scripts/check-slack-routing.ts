import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createRequire } from "node:module";

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
  assert.equal(readObject(join(root, "dist/extensions/acpx/package.json")).version, information.version, "The image must contain its matched ACPX runtime.");
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
        assert.equal(api.runtime.channel.routing.inboundRouteContractVersion, 1);
        assert.equal(typeof api.runtime.channel.routing.resolveInboundRoute, 'function');
        assert.equal(typeof api.registerInteractiveHandler, 'function');
        api.on('resolve_inbound_route', async () => undefined);
        api.registerInteractiveHandler({ channel: 'slack', namespace: 'routing-contract-check', handler: async () => ({ handled: true }) });
        writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ contractVersion: 1 }));
      } };
    `);
    const bundledSlack = join(root, "dist/extensions/slack");
    const bundledAcpx = join(root, "dist/extensions/acpx");
    assert.equal(readObject(join(bundledSlack, "package.json")).version, readObject(join(root, "package.json")).version, "The image must contain its matched Slack channel.");
    const configuration = join(directory, "configuration.json");
    writeFileSync(configuration, JSON.stringify({ channels: { slack: { enabled: true, botToken: "xoxb-test", appToken: "xapp-test" } }, plugins: { allow: ["routing-contract-check", "slack", "acpx"], load: { paths: [pluginDirectory, bundledSlack, bundledAcpx] }, entries: { "routing-contract-check": { enabled: true }, slack: { enabled: true }, acpx: { enabled: true } } } }));
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
    for (const pluginId of ["routing-contract-check", "slack", "acpx"]) {
      const output = execFileSync(process.execPath, [join(root, "openclaw.mjs"), "plugins", "info", pluginId, "--runtime", "--json"], {
        cwd: root,
        encoding: "utf8",
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const report: unknown = JSON.parse(output.slice(output.indexOf("{")));
      assert(report && typeof report === "object" && "plugin" in report);
      const plugin = report.plugin;
      assert(plugin && typeof plugin === "object" && "status" in plugin);
      assert.equal(plugin.status, "loaded", "Routing probe did not load in the real host.");
      assert.equal(readObject(receipt).contractVersion, 1, "Runtime registration was not executed.");
      if (pluginId === "slack" || pluginId === "acpx") {
        const bundledRoot = pluginId === "slack" ? bundledSlack : bundledAcpx;
        assert("source" in plugin && typeof plugin.source === "string");
        assert(realpathSync(plugin.source).startsWith(realpathSync(bundledRoot) + sep), `${pluginId} must load from the rebuilt image, not a retained archive.`);
        assert("version" in plugin);
        assert.equal(plugin.version, readObject(join(root, "package.json")).version);
      }
    }
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
