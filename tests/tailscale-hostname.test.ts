// Checks scripts/tailscale-hostname.mjs, which the entrypoint uses to turn the
// display name into the Tailscale machine name (the first label of the
// Gateway's https://<name>.<tailnet>.ts.net address).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const script = new URL("../scripts/tailscale-hostname.mjs", import.meta.url).pathname;

function hostname(name: string) {
  const result = spawnSync(process.execPath, [script, name], { encoding: "utf8" });
  return { status: result.status, output: result.stdout.trim() };
}

const cases: Array<[string, string]> = [
  ["openclaw", "openclaw"],
  ["Gowanus", "gowanus"],
  ["My Gateway", "my-gateway"],
  ["OpenClaw", "openclaw"],
  ["Steve's Agent", "steves-agent"],
  ["Steve’s Agent", "steves-agent"],
  ["Café Bot!", "cafe-bot"],
  ["  --Work__Laptop--  ", "work-laptop"],
  ["agent 2.0", "agent-2-0"],
  ["OPENCLAW-TEST-42", "openclaw-test-42"],
  ["🦞 Lobster", "lobster"],
];

for (const [input, expected] of cases) {
  test(`${JSON.stringify(input)} becomes ${expected}`, () => {
    assert.deepEqual(hostname(input), { status: 0, output: expected });
  });
}

test("cuts long names to the 63-character DNS label limit without a trailing hyphen", () => {
  const { status, output } = hostname(`${"a".repeat(62)} b`);
  assert.equal(status, 0);
  assert.equal(output, "a".repeat(62));
  assert.ok(hostname("x".repeat(100)).output.length === 63);
});

test("fails, printing nothing, when no letters or digits remain", () => {
  for (const input of ["", "🦞", "---", "東京"]) {
    assert.deepEqual(hostname(input), { status: 1, output: "" });
  }
});
