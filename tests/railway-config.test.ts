// Evaluates .railway/railway.ts with the Railway SDK and checks the settings
// the template depends on. This runs offline; it does not replace
// `railway config plan` against a real project.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createRailwayContext, project } from "railway/iac";

process.env.OPENCLAW_RAILWAY_REPOSITORY = "example/openclaw-railway";
const { default: program } = await import("../.railway/railway.ts");

type Resource = {
  type: string;
  name: string;
  build?: Record<string, unknown>;
  deploy?: Record<string, unknown>;
  variables?: Record<string, { type: string; value?: string }>;
  volumeAttachments?: Record<string, { mountPath: string }>;
  [key: string]: unknown;
};

const definition = await program(createRailwayContext({ environment: "production" }), project);
const resources = JSON.parse(JSON.stringify(definition)).resources as Resource[];

function findService(name: string): Resource {
  const service = resources.find((resource) => resource.type === "service" && resource.name === name);
  assert.ok(service, `service ${name} is defined`);
  return service;
}

// Total instances across regions; OpenClaw must run as exactly one Gateway.
function instanceCount(service: Resource): number {
  const regions = (service.deploy?.multiRegionConfig ?? {}) as Record<string, { numReplicas?: number }>;
  return Object.values(regions).reduce((total, region) => total + (region.numReplicas ?? 0), 0);
}

function mountPaths(service: Resource): string[] {
  return Object.values(service.volumeAttachments ?? {}).map((attachment) => attachment.mountPath);
}

test("defines exactly one service and one volume", () => {
  const summary = resources.map((resource) => `${resource.type}:${resource.name}`).sort();
  assert.deepEqual(summary, ["service:openclaw", "volume:openclaw-state"]);
});

test("openclaw runs one volume-backed, health-checked Gateway", () => {
  const openclaw = findService("openclaw");
  assert.equal(openclaw.build?.dockerfilePath, "Dockerfile");
  assert.equal(instanceCount(openclaw), 1);
  assert.equal(openclaw.deploy?.requiredMountPath, "/data");
  assert.equal(openclaw.deploy?.healthcheckPath, "/startupz");
  assert.equal(openclaw.deploy?.healthcheckTimeout, 600, "startup performance must fit the existing window");
  assert.equal(openclaw.deploy?.restartPolicyType, "ALWAYS");
  assert.equal(openclaw.variables?.RAILWAY_HEALTHCHECK_TIMEOUT_SEC?.value, String(openclaw.deploy?.healthcheckTimeout));
  assert.equal(openclaw.variables?.PORT, undefined, "no PORT: Railway's default 8080 is the health relay");
  assert.deepEqual(mountPaths(openclaw), ["/data"]);
});

test("volumes declare region and size, and services run in the same region", () => {
  for (const name of ["openclaw-state"]) {
    const volume = resources.find((resource) => resource.type === "volume" && resource.name === name);
    const config = volume?.config as { region?: string; sizeMB?: number } | undefined;
    assert.ok(config?.region, `${name} declares a region`);
    assert.ok(config?.sizeMB, `${name} declares a size`);
    for (const serviceName of ["openclaw"]) {
      const regions = Object.keys((findService(serviceName).deploy?.multiRegionConfig ?? {}) as object);
      assert.deepEqual(regions, [config.region], `${serviceName} runs in the volume region`);
    }
  }
});

test("disposable SQLite inspection snapshots use container storage", () => {
  assert.equal(findService("openclaw").variables?.XDG_CACHE_HOME?.value, "/tmp");
});

test("the baseline explicitly allows heartbeat DMs without selecting a delivery destination", async () => {
  const seed = JSON.parse(await readFile(new URL("../config/openclaw.seed.json", import.meta.url), "utf8"));
  assert.equal(seed.agents?.defaults?.heartbeat?.directPolicy, "allow");
  assert.equal(seed.agents?.defaults?.heartbeat?.target, undefined);
});

test("no service is exposed publicly", () => {
  for (const name of ["openclaw"]) {
    const service = findService(name);
    for (const key of ["domains", "networking", "tcp", "tcpProxies"]) {
      assert.equal(service[key], undefined, `${name} must not set ${key}`);
    }
  }
});

test("secrets come from Railway and are never written in the file", () => {
  assert.deepEqual(findService("openclaw").variables?.OPENCLAW_GATEWAY_TOKEN, { type: "preserve" });
  assert.deepEqual(findService("openclaw").variables?.TS_AUTHKEY, { type: "preserve" });
});

// Railway's builder accepts cache mounts only; ordinary Docker also accepts bind mounts.
test("Docker build mounts use Railway-supported cache mounts", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const instructions = dockerfile.replace(/\\\r?\n/g, " ");
  for (const [, instruction] of instructions.matchAll(/^RUN\s+(.+)$/gm)) {
    for (const [, mount] of instruction.matchAll(/(?:^|\s)--mount=([^\s]+)/g)) {
      assert.ok(mount.split(",").includes("type=cache"), `Railway does not support build mount ${mount}`);
    }
  }
});
