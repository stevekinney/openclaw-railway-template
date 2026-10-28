import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyHostLink, verifyWorkerResult } from "../scripts/check-runtime-workers.ts";

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "worker-host-test-"));
  try {
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "openclaw", version: "1.0.0" }));
    await writeFile(join(root, "dist/build-info.json"), JSON.stringify({ version: "1.0.0" }));
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("worker SDK imports resolve to the exact host package", async () => {
  await fixture(async (root) => {
    await symlink(root, join(root, "node_modules/openclaw"));
    await verifyHostLink(root);
  });
});

test("missing and foreign host links reject the image", async () => {
  await fixture(async (root) => {
    await assert.rejects(verifyHostLink(root));
    await symlink(tmpdir(), join(root, "node_modules/openclaw"));
    await assert.rejects(verifyHostLink(root), /exact packaged host/);
  });
});

test("an embedded package cannot substitute for the host", async () => {
  await fixture(async (root) => {
    await mkdir(join(root, "node_modules/openclaw"));
    await assert.rejects(verifyHostLink(root), /exact packaged host/);
  });
});

test("worker host and build versions must match", async () => {
  await fixture(async (root) => {
    await symlink(root, join(root, "node_modules/openclaw"));
    await writeFile(join(root, "dist/build-info.json"), JSON.stringify({ version: "2.0.0" }));
    await assert.rejects(verifyHostLink(root), /version mismatch/);
  });
});

test("the Codex worker is selected for both Docker build and production pruning", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.equal((dockerfile.match(/readdirSync\("\/tmp\/release-extensions"\), "codex"/g) ?? []).length, 2);
});

test("a worker failure, empty history, or placeholder result cannot satisfy the image gate", () => {
  for (const value of [{ result: { status: "rejected", reason: "history_read_failed" } }, { result: { status: "ok", value: [] } }, { result: { status: "ok", value: [{}, {}, {}] } }]) {
    assert.throws(() => verifyWorkerResult(value));
  }
});
