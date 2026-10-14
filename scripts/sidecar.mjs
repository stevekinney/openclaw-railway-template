// Runs beside the Gateway as `node`, started by the entrypoint. Two jobs, plus
// an opt-in third:
//
// 1. Run tailscaled. If it exits, stop the container (SIGTERM to PID 1, tini,
//    which forwards it to the Gateway) so Railway restarts Tailscale and the
//    Gateway together; the Gateway can't serve anything without it. Once the
//    Gateway is up, log its address, then check every minute that Tailscale
//    is still logged in (see watchTailscale).
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
// So no request may kill it: PORT is public when the service has a Railway
// domain, and anything unexpected is logged and answered, never thrown.
import { execFile, spawn } from "node:child_process";
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

for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (error) => console.error(`openclaw-railway: sidecar ${event}:`, error));
}

function tailscaleStatus() {
  return new Promise((resolve) => {
    execFile("tailscale", ["status", "--json"], { timeout: 10_000 }, (error, stdout) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

// Logs once when the Gateway first answers /startupz, so the deploy log ends
// with where to go next.
async function announceReady() {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const ready = await fetch(`http://127.0.0.1:${gatewayPort}/startupz`, { signal: AbortSignal.timeout(5000) })
      .then((response) => response.ok, () => false);
    if (ready) {
      const dnsName = tailscaled ? (await tailscaleStatus())?.Self?.DNSName?.replace(/\.$/, "") : undefined;
      console.log(dnsName
        ? `openclaw-railway: ready. Open https://${dnsName}/ on a device signed in to your tailnet.`
        : "openclaw-railway: ready.");
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

// A node key that expires, or a machine removed in the admin console, logs
// Tailscale out while the container keeps running, healthy but unreachable.
// After three minutes logged out: restart if TS_AUTHKEY is set, since the
// entrypoint then logs back in; otherwise say what to do, every half hour.
// OPENCLAW_RAILWAY_TEST_TAILSCALE_CHECK_MS: this repository's integration tests
// only, to check sooner than every minute.
function watchTailscale() {
  const canLogIn = process.env.OPENCLAW_RAILWAY_HAS_AUTHKEY === "1";
  const intervalMs = Number(process.env.OPENCLAW_RAILWAY_TEST_TAILSCALE_CHECK_MS) || 60_000;
  let loggedOutChecks = 0;
  let lastWarning = 0;
  const timer = setInterval(async () => {
    const state = (await tailscaleStatus())?.BackendState;
    loggedOutChecks = state === "NeedsLogin" || state === "NeedsMachineAuth" ? loggedOutChecks + 1 : 0;
    if (loggedOutChecks < 3) return;
    if (canLogIn && state === "NeedsLogin") {
      console.error("openclaw-railway: Tailscale is logged out (the node key expired or the machine was removed); restarting to log in again with TS_AUTHKEY");
      clearInterval(timer);
      process.kill(1, "SIGTERM");
    } else if (Date.now() - lastWarning > 30 * 60_000) {
      lastWarning = Date.now();
      console.error(state === "NeedsMachineAuth"
        ? "openclaw-railway: Tailscale is waiting for this machine to be approved; approve it on the admin console's Machines page. The Gateway is unreachable until then."
        : "openclaw-railway: Tailscale is logged out (the node key expired or the machine was removed), so the Gateway is unreachable. Set a new TS_AUTHKEY; Railway redeploys and the container logs back in.");
    }
  }, intervalMs).unref();
}

announceReady().then((ready) => {
  if (ready && tailscaled) watchTailscale();
});

const server = createServer(async (request, response) => {
  let path;
  try {
    path = new URL(request.url, "http://relay").pathname;
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (!probePaths.has(path) || !["GET", "HEAD"].includes(request.method)) {
    if (!webhooks) {
      response.writeHead(404).end();
      return;
    }
    try {
      await webhooks(request, response);
    } catch (error) {
      console.error("openclaw-railway: webhook relay error:", error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
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
});
// Bounds on how long a caller may take to send a request; the webhook routes'
// upstream time is limited separately.
server.headersTimeout = 20_000;
server.requestTimeout = 60_000;
server.on("error", (error) => {
  console.error(`openclaw-railway: the health check relay can't listen on port ${relayPort}:`, error.message);
});
server.listen(relayPort, "::");
