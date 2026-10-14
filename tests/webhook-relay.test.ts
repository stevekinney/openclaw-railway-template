// Checks scripts/webhook-relay.mjs, the public webhook routes on PORT, against
// stand-ins for the Gateway and the Gmail watcher. tests/image.test.sh covers
// the same routes end to end through the real Gateway; this covers what that
// can't observe, such as which headers reach the Gateway.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

type Handler = (request: Parameters<RequestListener>[0], response: Parameters<RequestListener>[1]) => Promise<void>;
type Received = { path: string; headers: IncomingHttpHeaders; body: string };

const relayModule = new URL("../scripts/webhook-relay.mjs", import.meta.url).href;
const { createWebhookHandler } = (await import(relayModule)) as {
  createWebhookHandler: (options: { gatewayPort: number; gmailPort: number; hooksToken: string; maxBodyBytes: number }) => Handler;
};

const hooksToken = "hooks-token-0123456789abcdef0123456789abcdef";
let received: Received[] = [];
let gateway: Server;
let gmail: Server;
let relay: Server;
let relayPort: number;

function listen(server: Server) {
  return new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function record(status: number): RequestListener {
  return (request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({ path: request.url ?? "", headers: request.headers, body });
      response.writeHead(status, { "content-type": "application/json" }).end("{}");
    });
  };
}

before(async () => {
  gateway = createServer(record(200));
  // The Gmail watcher checks its own token; this one rejects every push.
  gmail = createServer(record(401));
  const handler = createWebhookHandler({
    gatewayPort: await listen(gateway),
    gmailPort: await listen(gmail),
    hooksToken,
    maxBodyBytes: 1000,
  });
  relay = createServer((request, response) => void handler(request, response));
  relayPort = await listen(relay);
});

after(() => {
  for (const server of [gateway, gmail, relay]) server.close();
});

beforeEach(() => {
  received = [];
});

function post(path: string, headers: Record<string, string> = {}, body = "{}") {
  return fetch(`http://127.0.0.1:${relayPort}${path}`, { method: "POST", headers, body });
}

// For requests fetch() won't send: a raw request, returning the status code.
async function raw(request: string) {
  const socket = connect(relayPort, "127.0.0.1");
  await once(socket, "connect");
  socket.write(request);
  let response = "";
  socket.on("data", (chunk) => (response += chunk));
  await once(socket, "close");
  return /^HTTP\/1\.1 (\d{3})/.exec(response)?.[1] ?? "closed";
}

test("an authenticated hook reaches the Gateway with the relay's own Authorization header", async () => {
  const response = await post("/hooks/wake", { "x-openclaw-token": hooksToken });
  assert.equal(response.status, 200);
  assert.equal(received[0].path, "/hooks/wake");
  assert.equal(received[0].headers.authorization, `Bearer ${hooksToken}`);
  assert.equal(received[0].headers["x-openclaw-token"], undefined);
});

test("identity, proxy, browser, and OpenClaw headers are stripped; the sender's own are kept", async () => {
  await post("/hooks/github", {
    authorization: `Bearer ${hooksToken}`,
    "tailscale-user-login": "someone@example.com",
    "x-tailscale-user": "someone",
    "x-forwarded-for": "100.64.0.9",
    "x-real-ip": "100.64.0.9",
    forwarded: "for=100.64.0.9",
    via: "1.1 proxy",
    cookie: "openclaw_session=stolen",
    origin: "https://evil.example",
    referer: "https://evil.example/",
    "x-openclaw-scopes": "admin",
    "x-railway-request-id": "abc",
    "x-hub-signature-256": "sha256=feedface",
    "x-github-event": "push",
    "user-agent": "GitHub-Hookshot/1",
  });
  const headers = received[0].headers;
  for (const name of ["tailscale-user-login", "x-tailscale-user", "x-forwarded-for", "x-real-ip", "forwarded", "via", "cookie", "origin", "referer", "x-openclaw-scopes", "x-railway-request-id"]) {
    assert.equal(headers[name], undefined, name);
  }
  assert.equal(headers["x-hub-signature-256"], "sha256=feedface");
  assert.equal(headers["x-github-event"], "push");
  assert.equal(headers["user-agent"], "GitHub-Hookshot/1");
});

test("a wrong token of any length is refused without reaching the Gateway", async () => {
  for (const token of ["x", hooksToken.slice(0, -1), `${hooksToken}x`, hooksToken.replace(/.$/, "0")]) {
    const response = await post("/hooks/wake", { authorization: `Bearer ${token}`, "x-forwarded-for": "192.0.2.50" });
    assert.equal(response.status, 401, token);
  }
  assert.equal(received.length, 0);
});

test("the path-segment token works and is not forwarded", async () => {
  const response = await post(`/hooks/wake/${hooksToken}`);
  assert.equal(response.status, 200);
  assert.equal(received[0].path, "/hooks/wake");
});

test("encoded slashes and dot segments in a hook path are refused (404)", async () => {
  for (const path of ["/hooks/a%2F..%2Fb", "/hooks/a%2fb", "/hooks/a%5Cb", "/hooks//wake"]) {
    const response = await post(path, { authorization: `Bearer ${hooksToken}` });
    assert.equal(response.status, 404, path);
  }
  assert.equal(received.length, 0);
});

test("malformed request lines get 400 and the relay keeps serving", async () => {
  assert.equal(await raw("POST // HTTP/1.1\r\nHost: relay\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"), "400");
  const response = await post("/hooks/wake", { authorization: `Bearer ${hooksToken}` });
  assert.equal(response.status, 200);
});

test("a declared Content-Length over the limit is refused (413) before the body is read", async () => {
  const status = await raw(
    `POST /hooks/wake HTTP/1.1\r\nHost: relay\r\nAuthorization: Bearer ${hooksToken}\r\nContent-Length: 50000000\r\n\r\n`,
  );
  assert.equal(status, "413");
  assert.equal(received.length, 0);
});

test("a streamed body that passes the limit is refused (413)", async () => {
  const chunks = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(800)));
      controller.enqueue(new TextEncoder().encode("x".repeat(800)));
      controller.close();
    },
  });
  const response = await fetch(`http://127.0.0.1:${relayPort}/hooks/wake`, {
    method: "POST",
    headers: { authorization: `Bearer ${hooksToken}` },
    body: chunks,
    duplex: "half",
  } as RequestInit);
  assert.equal(response.status, 413);
  assert.equal(received.length, 0);
});

test("lockout follows the last X-Forwarded-For entry, which Railway's edge appends", async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    // A client can prepend anything, and set X-Real-IP; neither changes the caller.
    await post("/hooks/wake", { "x-forwarded-for": `198.51.100.${attempt}, 203.0.113.7`, "x-real-ip": `192.0.2.${attempt}` });
  }
  const locked = await post("/hooks/wake", { authorization: `Bearer ${hooksToken}`, "x-forwarded-for": "203.0.113.7" });
  assert.equal(locked.status, 429);
  const other = await post("/hooks/wake", { authorization: `Bearer ${hooksToken}`, "x-forwarded-for": "203.0.113.8" });
  assert.equal(other.status, 200);
});

test("rejected Gmail pushes never lock a caller out", async () => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const response = await post("/gmail-pubsub?token=wrong", { "x-forwarded-for": "64.233.160.1", "content-type": "application/json" });
    assert.equal(response.status, 401);
  }
  const hook = await post("/hooks/wake", { authorization: `Bearer ${hooksToken}`, "x-forwarded-for": "64.233.160.1" });
  assert.equal(hook.status, 200);
});

test("the Gmail route forwards only the content type", async () => {
  await post("/gmail-pubsub?token=t", { "content-type": "application/json", cookie: "a=b", "x-goog-thing": "1" });
  assert.equal(received[0].path, "/gmail-pubsub?token=t");
  assert.equal(received[0].headers["content-type"], "application/json");
  assert.equal(received[0].headers.cookie, undefined);
  assert.equal(received[0].headers["x-goog-thing"], undefined);
});

test("anything but POST to a known route is 404", async () => {
  assert.equal((await fetch(`http://127.0.0.1:${relayPort}/hooks/wake`)).status, 404);
  assert.equal((await post("/v1/models", { authorization: `Bearer ${hooksToken}` })).status, 404);
});
