// Public webhook routes, served by sidecar.mjs on PORT next to the health check
// relay when OPENCLAW_RAILWAY_WEBHOOKS is on. They become public only when the
// service also has a Railway domain; the template ships without one. The
// Gateway itself stays on loopback, and its dashboard stays tailnet-only.
//
// Routes (POST only; everything else is 404):
//   /gmail-pubsub?token=…   Google Pub/Sub pushes for OpenClaw's Gmail watcher
//                           (gog gmail watch serve), which checks its own token.
//   /hooks/<name>           OpenClaw hook endpoints. Authenticate with the hooks
//                           token in a header (Authorization: Bearer or
//                           x-openclaw-token), or, for senders that can't set
//                           headers, as a last path segment: /hooks/<name>/<token>.
//
// The relay checks the hooks token itself and forwards only authenticated hook
// requests, so failed attempts never reach the Gateway: every relayed request
// comes from loopback, and the Gateway would otherwise count all public callers
// as one client. Failures are limited here, per caller; Gmail pushes are not
// counted, since Google's addresses are shared and its push retries.
//
// Hook requests keep the sender's own headers, because transforms check
// signatures such as X-Hub-Signature, but never ones that could make a public
// caller look like a tailnet user, a proxy, or a browser session: forwarded,
// Railway, and Tailscale headers, cookies, origins, and OpenClaw's own.
import { createHash, timingSafeEqual } from "node:crypto";

const strippedHeader = /^(host|connection|keep-alive|transfer-encoding|upgrade|te|trailer|proxy-.*|content-length|forwarded|via|x-forwarded-.*|x-real-ip|true-client-ip|cf-connecting-ip|x-railway-.*|x-envoy-.*|.*tailscale.*|cookie|origin|referer|x-openclaw-.*)$/i;
const failureWindowMs = 60_000;
const maxFailures = 20;
const lockoutMs = 10 * 60_000;
const maxTrackedCallers = 10_000;

// Compares digests, so neither the time taken nor an early length check
// reveals anything about the secret.
function sameSecret(candidate, secret) {
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(candidate), digest(secret));
}

// Rejects with status 413 as soon as the body passes the limit (or declares a
// larger Content-Length) without reading the rest.
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error("body too large"), { status: 413 });
    if (Number(request.headers["content-length"]) > limit) {
      reject(tooLarge());
      return;
    }
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
        return;
      }
      request.pause();
      reject(tooLarge());
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function bearerToken(headers) {
  const match = /^Bearer\s+(.+)$/i.exec(String(headers.authorization ?? ""));
  return match?.[1] ?? (typeof headers["x-openclaw-token"] === "string" ? headers["x-openclaw-token"] : undefined);
}

export function createWebhookHandler({ gatewayPort, gmailPort, hooksPath = "/hooks", hooksToken, maxBodyBytes = 1024 * 1024 }) {
  const failures = new Map(); // caller -> { count, since, lockedUntil }

  function isLocked(caller, now) {
    const entry = failures.get(caller);
    return Boolean(entry && entry.lockedUntil > now);
  }
  function recordResult(caller, status, now) {
    if (status !== 401 && status !== 403) return;
    if (failures.size >= maxTrackedCallers && !failures.has(caller)) {
      for (const [key, entry] of failures) {
        if (entry.lockedUntil <= now && now - entry.since > failureWindowMs) failures.delete(key);
      }
      // Still full: every entry is current. Forget the oldest rather than grow.
      if (failures.size >= maxTrackedCallers) failures.delete(failures.keys().next().value);
    }
    const entry = failures.get(caller) ?? { count: 0, since: now, lockedUntil: 0 };
    if (now - entry.since > failureWindowMs) Object.assign(entry, { count: 0, since: now });
    entry.count += 1;
    if (entry.count >= maxFailures) entry.lockedUntil = now + lockoutMs;
    failures.set(caller, entry);
  }

  return async (request, response) => {
    let url;
    try {
      url = new URL(request.url, "http://relay");
    } catch {
      response.writeHead(400).end();
      return;
    }
    // Railway's edge appends the caller to X-Forwarded-For, after anything the
    // client sent, so only the last entry is trustworthy. (X-Real-IP is not
    // used: a request that didn't come through the edge could set it freely.)
    const forwarded = String(request.headers["x-forwarded-for"] ?? "").split(",").at(-1).trim();
    const caller = forwarded || String(request.socket.remoteAddress ?? "");
    const now = Date.now();
    let target;
    const headers = {};

    if (request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const gmail = url.pathname === "/gmail-pubsub";
    if (!gmail && isLocked(caller, now)) {
      response.writeHead(429, { "retry-after": String(lockoutMs / 1000) }).end("too many failed attempts\n");
      return;
    }
    if (gmail) {
      target = `http://127.0.0.1:${gmailPort}${url.pathname}${url.search}`;
      if (request.headers["content-type"]) headers["content-type"] = request.headers["content-type"];
    } else if (url.pathname.startsWith(`${hooksPath}/`)) {
      const segments = url.pathname.slice(hooksPath.length + 1).split("/");
      for (const [name, value] of Object.entries(request.headers)) {
        if (!strippedHeader.test(name)) headers[name] = value;
      }
      if (!hooksToken) {
        response.writeHead(503).end("hooks token not configured (OPENCLAW_HOOKS_TOKEN)\n");
        return;
      }
      const headerToken = bearerToken(request.headers);
      let authenticated = headerToken !== undefined && sameSecret(headerToken, hooksToken);
      if (!authenticated && segments.length >= 2 && sameSecret(segments.at(-1), hooksToken)) {
        segments.pop();
        authenticated = true;
      }
      if (!authenticated) {
        recordResult(caller, 401, now);
        response.writeHead(401).end("Unauthorized\n");
        return;
      }
      headers.authorization = `Bearer ${hooksToken}`;
      delete headers["x-openclaw-token"];
      // Encoded slashes and backslashes too: the Gateway might decode them
      // into a different hook path than the one checked here.
      if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || /%(2f|5c)|\\/i.test(segment))) {
        response.writeHead(404).end();
        return;
      }
      target = `http://127.0.0.1:${gatewayPort}${hooksPath}/${segments.join("/")}${url.search}`;
    } else {
      response.writeHead(404).end();
      return;
    }

    try {
      const body = await readBody(request, maxBodyBytes);
      const upstream = await fetch(target, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(120_000),
      });
      if (!gmail) recordResult(caller, upstream.status, Date.now());
      const responseHeaders = {};
      for (const name of ["content-type", "retry-after"]) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders[name] = value;
      }
      response.writeHead(upstream.status, responseHeaders);
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      const status = error.status ?? 502;
      // After a 413 the rest of the body is never read; close the connection
      // once the response is out instead of keeping it for another request.
      if (status === 413) response.setHeader("connection", "close");
      response.writeHead(status).end(status === 413 ? "request body too large\n" : "upstream unavailable\n");
      if (status === 413) response.on("finish", () => request.destroy());
    }
  };
}
