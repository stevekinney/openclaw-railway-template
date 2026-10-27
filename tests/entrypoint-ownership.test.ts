import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const entrypoint = new URL("../scripts/entrypoint.sh", import.meta.url).pathname;

function runOwnershipRepair(failure = "") {
  const directory = mkdtempSync(path.join(tmpdir(), "openclaw-ownership-"));
  try {
    const binaries = path.join(directory, "bin");
    mkdirSync(binaries);
    const executable = (name: string, source: string) => {
      const filename = path.join(binaries, name);
      writeFileSync(filename, `#!/bin/sh\nset -eu\n${source}\n`);
      chmodSync(filename, 0o755);
    };
    executable("node", `
case "$1" in
  *tailscale-hostname.mjs) echo openclaw ;;
  -e)
    count=0
    for job in state home tailscale; do
      [ ! -f "$OWNERSHIP_TEST_DIRECTORY/finished-$job" ] || count=$((count + 1))
    done
    [ "$count" = 3 ] || exit 98
    echo continued >> "$OWNERSHIP_TEST_DIRECTORY/events"
    echo old
    ;;
  *) exit 99 ;;
esac`);
    executable("find", `
case "$1" in
  "$OPENCLAW_HOME/.openclaw") job=state ;;
  "$HOME") job=home ;;
  "$TS_STATE_DIR") job=tailscale ;;
  *) exit 97 ;;
esac
touch "$OWNERSHIP_TEST_DIRECTORY/started-$job"
attempt=0
while :; do
  count=0
  for sibling in state home tailscale; do
    [ ! -f "$OWNERSHIP_TEST_DIRECTORY/started-$sibling" ] || count=$((count + 1))
  done
  [ "$count" != 3 ] || break
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || exit 96
  sleep 0.01
done
case "$job" in state) sleep 0.04 ;; home) sleep 0.02 ;; esac
touch "$OWNERSHIP_TEST_DIRECTORY/finished-$job"
[ "$OWNERSHIP_TEST_FAILURE" != "$job" ] || exit 42`);
    // Exercise the exact ownership barrier independently of privileged startup.
    // Full image security tests cover the immutable root PATH and admission flow.
    const source = readFileSync(entrypoint, "utf8");
    const start = source.indexOf('ownership_process_identifiers=""');
    const end = source.indexOf('\nif [ ! -e "$config_file" ]', start);
    assert.ok(start >= 0 && end > start, "entrypoint ownership barrier must exist");
    const ownership = `set -eu
fail() { exit 64; }
state_directory="$OPENCLAW_HOME/.openclaw"
${source.slice(start, end)}
node -e ownership-complete
`;
    const result = spawnSync("sh", ["-c", ownership], {
      encoding: "utf8",
      env: {
        PATH: `${binaries}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: path.join(directory, "home"),
        OPENCLAW_HOME: path.join(directory, "volume"),
        OPENCLAW_GATEWAY_TOKEN: "ownership-regression-token-with-32-characters",
        OPENCLAW_GATEWAY_PORT: "18789",
        TS_STATE_DIR: path.join(directory, "tailscale"),
        TS_SOCKET: path.join(directory, "tailscale.sock"),
        OWNERSHIP_TEST_DIRECTORY: directory,
        OWNERSHIP_TEST_FAILURE: failure,
      },
    });
    const completed = ["state", "home", "tailscale"].filter((job) => {
      try {
        readFileSync(path.join(directory, `finished-${job}`));
        return true;
      } catch {
        return false;
      }
    });
    let continued = false;
    try {
      continued = readFileSync(path.join(directory, "events"), "utf8").includes("continued");
    } catch {
      // Refused ownership repair must stop before configuration or Gateway startup.
    }
    return { status: result.status, error: result.error, completed, continued };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("all volume ownership walks overlap and finish before configuration admission", () => {
  const result = runOwnershipRepair();
  assert.equal(result.error, undefined);
  assert.deepEqual(result.completed, ["state", "home", "tailscale"]);
  assert.equal(result.continued, true);
  assert.equal(result.status, 0);
});

for (const root of ["state", "home", "tailscale"]) {
  test(`a failed ${root} ownership walk prevents configuration admission`, () => {
    const result = runOwnershipRepair(root);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.completed, ["state", "home", "tailscale"]);
    assert.equal(result.continued, false);
    assert.notEqual(result.status, 0);
  });
}
