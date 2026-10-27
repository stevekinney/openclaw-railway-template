import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";

const sidecar = new URL("../scripts/sidecar.mjs", import.meta.url).pathname;

for (const webhooks of ["off", "on"]) {
  test(`malformed request targets do not crash the sidecar with webhooks ${webhooks}`, async (context) => {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    assert.ok(address && typeof address !== "string");
    await new Promise<void>((resolve) => reservation.close(() => resolve()));

    const child = spawn(process.execPath, [sidecar], {
      env: {
        ...process.env,
        PORT: String(address.port),
        OPENCLAW_GATEWAY_PORT: "1",
        OPENCLAW_RAILWAY_TEST_WITHOUT_TAILSCALE: "1",
        OPENCLAW_RAILWAY_WEBHOOKS: webhooks,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += String(chunk); });
    context.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    });

    const url = `http://127.0.0.1:${address.port}`;
    const deadline = Date.now() + 5000;
    while (true) {
      assert.equal(child.exitCode, null, errors);
      try {
        const response = await fetch(`${url}/missing`, { signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        assert.equal(response.status, 404);
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await setTimeout(20);
      }
    }

    for (const target of ["//", "//[", "http://["]) {
      const socket = connect(address.port, "127.0.0.1");
      context.after(() => socket.destroy());
      socket.setTimeout(2000, () => socket.destroy(new Error("request did not complete")));
      let response = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => { response += chunk; });
      await once(socket, "connect");
      const closed = once(socket, "close");
      socket.end(`GET ${target} HTTP/1.1\r\nHost: relay\r\nConnection: close\r\n\r\n`);
      await closed;
      assert.match(response, /^HTTP\/1\.1 400 /, `${target}: ${errors}`);
      const healthy = await fetch(`${url}/missing`);
      assert.equal(healthy.status, 404);
      await healthy.arrayBuffer();
      assert.equal(child.exitCode, null, errors);
    }
  });
}
