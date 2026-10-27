import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

const webhookModule = new URL("../scripts/webhook-relay.mjs", import.meta.url);
const { createWebhookHandler } = await import(webhookModule.href);

test("forwarding headers cannot evade lockouts or lock out another socket peer", async (context) => {
  const upstream = createServer((request, response) => {
    request.resume();
    response.end("accepted");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");

  const relay = createServer(createWebhookHandler({
    gatewayPort: upstreamAddress.port,
    gmailPort: upstreamAddress.port,
    hooksToken: "security-regression-hooks-token",
  }));
  relay.listen(0, "::");
  await once(relay, "listening");
  const relayAddress = relay.address();
  assert.ok(relayAddress && typeof relayAddress !== "string");
  const relayPort = relayAddress.port;
  context.after(async () => {
    relay.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => relay.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  });

  async function status(host: string, reportedAddress: string, token = "incorrect"): Promise<number> {
    const response = await fetch(`http://${host}:${relayPort}/hooks/wake`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-real-ip": reportedAddress,
        "x-forwarded-for": reportedAddress,
      },
      body: "{}",
    });
    await response.arrayBuffer();
    return response.status;
  }

  // Forge the other caller's identity while exhausting the attacker's bucket.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal(await status("127.0.0.1", "::1"), 401);
  }
  assert.equal(await status("127.0.0.1", "203.0.113.8"), 429);
  assert.equal(await status("127.0.0.1", "198.51.100.2", "security-regression-hooks-token"), 429);
  assert.equal(await status("[::1]", "::1", "security-regression-hooks-token"), 200);
});

test("rotating forged client addresses does not create fresh failure budgets", async (context) => {
  const relay = createServer(createWebhookHandler({ gatewayPort: 1, gmailPort: 1, hooksToken: "test-token" }));
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  context.after(() => { relay.closeAllConnections(); relay.close(); });
  for (let attempt = 0; attempt < 21; attempt += 1) {
    const response: Response = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
      method: "POST",
      headers: { "x-real-ip": `203.0.113.${attempt}`, "x-forwarded-for": `198.51.100.${attempt}` },
      body: "{}",
    });
    await response.arrayBuffer();
    assert.equal(response.status, attempt < 20 ? 401 : 429);
  }
});
