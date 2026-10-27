// Runs beside the Gateway as `node`, started by the entrypoint. Two jobs, plus
// an opt-in third:
//
// 1. Run tailscaled. If it exits, stop the container (SIGTERM to PID 1, tini,
//    which forwards it to the Gateway) so Railway restarts Tailscale and the
//    Gateway together; the Gateway can't serve anything without it.
// 2. Relay Railway's deploy health check. gateway.tailscale.mode=serve requires
//    a loopback-only Gateway, which Railway can't reach, so this forwards exactly
//    the three unauthenticated probe paths from PORT. Nothing else is relayed: a
//    general forwarder would make every caller on Railway's private network look
//    like a local client to the Gateway.
//
// 3. With OPENCLAW_RAILWAY_WEBHOOKS on, also serve the webhook routes
//    (webhook-relay.mjs) on PORT. They are public only if the service has a
//    Railway domain.
//
// If this process itself dies, the relay stops but nothing restarts the
// container. Railway only probes at deploy time, so the Gateway keeps serving.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createWebhookHandler } from "./webhook-relay.mjs";

const probePaths = new Set(["/healthz", "/readyz", "/startupz"]);
const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT;
const relayPort = Number(process.env.PORT || 8080);
const webhooks = /^(on|1|true|yes)$/i.test(process.env.OPENCLAW_RAILWAY_WEBHOOKS ?? "")
  ? createWebhookHandler({
      gatewayPort,
      gmailPort: Number(process.env.OPENCLAW_RAILWAY_GMAIL_WATCH_PORT || 8788),
      hooksToken: process.env.OPENCLAW_HOOKS_TOKEN,
    })
  : null;

// OPENCLAW_RAILWAY_TEST_WITHOUT_TAILSCALE: this repository's integration tests
// only; see scripts/entrypoint.sh.
const tailscaled = process.env.OPENCLAW_RAILWAY_TEST_WITHOUT_TAILSCALE ? null : spawn(
  "tailscaled",
  ["--tun=userspace-networking", `--statedir=${process.env.TS_STATE_DIR}`, `--socket=${process.env.TS_SOCKET}`],
  { stdio: "inherit" },
);
tailscaled?.on("exit", (code, signal) => {
  console.error(`openclaw-railway: tailscaled exited (${signal ?? code}); stopping the container`);
  try {
    process.kill(1, "SIGTERM");
  } finally {
    process.exit(1);
  }
});

createServer(async (request, response) => {
  let path;
  try {
    path = new URL(request.url, "http://relay").pathname;
  } catch {
    response.writeHead(400).end("invalid request target\n");
    return;
  }
  if (!probePaths.has(path) || !["GET", "HEAD"].includes(request.method)) {
    if (webhooks) await webhooks(request, response);
    else response.writeHead(404).end();
    return;
  }
  try {
    const upstream = await fetch(`http://127.0.0.1:${gatewayPort}${path}`, {
      method: request.method,
      signal: AbortSignal.timeout(5000),
    });
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/plain" });
    response.end(request.method === "HEAD" ? undefined : Buffer.from(await upstream.arrayBuffer()));
  } catch {
    response.writeHead(503).end("gateway unavailable\n");
  }
}).listen(relayPort, "::");
