#!/bin/sh
# Integration tests for the OpenClaw image. Requires Docker.
#
#   sh tests/image.test.sh               # build the image, then test it
#   SKIP_BUILD=1 sh tests/image.test.sh  # test an image that is already built
#   TAILSCALE_TEST_AUTHKEY=tskey-... sh tests/image.test.sh
#                                        # also run the live tier on a tailnet
#
# The core tier needs no tailnet. It runs the Gateway with Tailscale skipped
# (OPENCLAW_RAILWAY_TEST_WITHOUT_TAILSCALE, test-only), so the Gateway is
# loopback-only and authentication is exercised from inside the container. A
# second container on a private Docker network plays Railway's health check,
# which can only reach the sidecar's relay.
#
# The live tier logs a real node in to a tailnet with TAILSCALE_TEST_AUTHKEY.
# Use a reusable, ephemeral key: the node logs out at the end, and Tailscale
# removes ephemeral nodes once they go offline.
#
# Conditions passed to check() are single-quoted on purpose: check() evals them
# later, so ShellCheck cannot see where their variables are used.
# shellcheck disable=SC2016,SC2034
set -eu
exec 3>&2

cd "$(dirname "$0")/.."

image="${IMAGE:-openclaw-railway:test}"
token="test-token-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
hooks_token="hooks-token-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
run_id="openclaw-test-$$"
network="$run_id-network"
gateway="$run_id-gateway"
watchdog="$run_id-watchdog"
live="$run_id-live"
live_twin="$run_id-live-twin"
live_hostname="openclaw-test-$$"
live_display_name="OpenClaw Test $$"
failures=0

log() { printf '\n== %s\n' "$*"; }
pass() { printf '  ok   %s\n' "$*"; }
fail() {
  printf '  FAIL %s\n' "$*"
  failures=$((failures + 1))
}
# check <description> <shell condition>: the condition is evaluated in this shell.
check() {
  if eval "$2" >/dev/null 2>&1; then pass "$1"; else fail "$1"; fi
}

cleanup() {
  # Log the live machines out so they leave the tailnet now, not when the
  # ephemeral-node timeout removes them.
  docker exec "$live" as-node tailscale logout >/dev/null 2>&1 || true
  docker exec "$live_twin" as-node tailscale logout >/dev/null 2>&1 || true
  docker rm -f "$gateway" "$watchdog" "$live" "$live_twin" >/dev/null 2>&1 || true
  docker volume rm -f "$run_id-state" "$run_id-old-state" "$run_id-gmail-state" "$run_id-live-state" "$run_id-live-twin-state" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# The Gateway without Tailscale: loopback-only, reachable only from inside.
start_gateway() {
  docker run -d --name "$gateway" --network "$network" -v "$run_id-state:/data" \
    -e OPENCLAW_GATEWAY_TOKEN="$token" -e OPENCLAW_RAILWAY_TEST_WITHOUT_TAILSCALE=1 -e OPENCLAW_DEBUG=1 \
    -e OPENCLAW_RAILWAY_WEBHOOKS=on -e OPENCLAW_HOOKS_TOKEN="$hooks_token" \
    "$image" node openclaw.mjs gateway --bind loopback --tailscale off --auth token >/dev/null
}

# Prints the status of a request to the webhook routes on PORT (8080), made from
# another container on the network, the way Railway's edge delivers it when the
# service has a domain. Extra arguments are name=value request headers; METHOD
# overrides POST and BODY_BYTES sends a body of that many bytes.
relay_status() {
  path="$1"
  shift
  docker run --rm --network "$network" --entrypoint node "$image" -e '
    const [method, url, size, ...pairs] = process.argv.slice(1);
    const headers = { "content-type": "application/json", ...Object.fromEntries(pairs.map((pair) => pair.split(/=(.*)/s).slice(0, 2))) };
    const body = method === "POST" ? (Number(size) > 0 ? "x".repeat(Number(size)) : JSON.stringify({ text: "relay test", mode: "next-heartbeat", agentId: "main" })) : undefined;
    fetch(url, { method, headers, body }).then((response) => console.log(response.status), () => console.log("unreachable"));
  ' "${METHOD:-POST}" "http://$(container_address "$gateway"):8080$path" "${BODY_BYTES:-0}" "$@"
}

container_address() {
  docker inspect -f "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}" "$1"
}

# Prints the status of a request made from another container on the network,
# the way Railway's health check reaches the service. Extra arguments are
# name=value request headers; METHOD and PORT override GET and 8080.
remote_status() {
  path="$1"
  shift
  docker run --rm --network "$network" --entrypoint node "$image" -e '
    const [method, url, ...pairs] = process.argv.slice(1);
    const headers = Object.fromEntries(pairs.map((pair) => pair.split(/=(.*)/s).slice(0, 2)));
    fetch(url, { method, headers, signal: AbortSignal.timeout(5000) })
      .then((response) => console.log(response.status), () => console.log("unreachable"));
  ' "${METHOD:-GET}" "http://$(container_address "$gateway"):${PORT:-8080}$path" "$@"
}

# Prints the status of a request to the Gateway's own loopback listener, made
# from inside the container. Extra arguments are name=value request headers.
local_status() {
  path="$1"
  shift
  docker exec -u node "$gateway" node -e '
    const [url, ...pairs] = process.argv.slice(1);
    const headers = Object.fromEntries(pairs.map((pair) => pair.split(/=(.*)/s).slice(0, 2)));
    fetch(url, { headers }).then((response) => console.log(response.status), () => console.log("unreachable"));
  ' "http://127.0.0.1:18789$path" "$@"
}

wait_for_startup() {
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    [ "$(remote_status /startupz 2>/dev/null || true)" = 200 ] && return 0
    [ "$(docker inspect -f "{{.State.Running}}" "$gateway")" = true ] || break
    attempt=$((attempt + 1))
    sleep 2
  done
  # check() hides command output; keep failed-start diagnostics on a separate
  # descriptor so CI records the refusal before cleanup removes the container.
  docker inspect --format '{{json .State}}' "$gateway" >&3
  docker logs --tail 100 "$gateway" >&3 2>&3
  return 1
}

# Runs the OpenClaw CLI the way an operator does after `railway ssh`: as root,
# through the wrapper that drops to the node user.
gateway_cli() {
  docker exec "$gateway" openclaw "$@"
}

root_owned_state() {
  docker exec "$gateway" find /data -user root
}

# Prints a field of `tailscale status --json` in a container.
tailscale_field() {
  docker exec "$1" as-node tailscale status --json | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk)).on("end", () => {
      const status = JSON.parse(input);
      console.log(process.argv[1] === "DNSName" ? status.Self.DNSName.replace(/\.$/, "") : status[process.argv[1]]);
    });' "$2"
}

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  log "build"
  docker build -q -t "$image" . >/dev/null
  pass "the image builds"
fi

docker network create "$network" >/dev/null

log "versions"
pinned_version="$(sed -n 's|^FROM ghcr.io/openclaw/openclaw:\([^@]*\)@sha256:.*|\1|p' Dockerfile)"
installed_version="$(docker run --rm --entrypoint node "$image" /app/openclaw.mjs --version | sed -n 's/^OpenClaw \([^ ]*\).*/\1/p')"
check "installed OpenClaw ($installed_version) matches the Dockerfile pin ($pinned_version)" \
  '[ -n "$pinned_version" ] && [ "$pinned_version" = "$installed_version" ]'
pinned_tailscale="$(sed -n 's|^FROM tailscale/tailscale:v\([^@]*\)@sha256:.* AS tailscale$|\1|p' Dockerfile)"
installed_tailscale="$(docker run --rm --entrypoint tailscale "$image" version | head -1)"
check "installed Tailscale ($installed_tailscale) matches the Dockerfile pin ($pinned_tailscale)" \
  '[ -n "$pinned_tailscale" ] && [ "$pinned_tailscale" = "$installed_tailscale" ]'

patch_digest="$(node -e 'process.stdout.write(require("node:crypto").hash("sha256", require("node:fs").readFileSync("scripts/openclaw-plugin-capture.patch")))')"
check "activation metadata identifies the exact applied runtime patch" \
  'docker run --rm --entrypoint node "$image" -e '"'"'
    const information = require("/app/dist/build-info.json");
    require("node:assert/strict").equal(information.railwayPatchDigest, process.argv[1]);
  '"'"' "$patch_digest"'
routing_patch_digest="$(sed -n 's|^ADD --checksum=sha256:\([a-f0-9]*\) https://raw.githubusercontent.com/stevekinney/openclaw-plugin-slack-workspace/.*|\1|p' Dockerfile)"
check "the image identifies the exact pinned Slack routing patch" \
  'docker run --rm --entrypoint node "$image" -e '"'"'
    const information = require("/app/dist/build-info.json");
    const assert = require("node:assert/strict");
    assert.equal(information.slackRoutingContractVersion, 1);
    assert.equal(information.slackRoutingPatchDigest, process.argv[1]);
  '"'"' "$routing_patch_digest"'
check "the real host registers a plugin against the Slack routing contract" \
  'docker run --rm --entrypoint node "$image" /usr/local/lib/openclaw-railway/check-slack-routing.ts runtime /app /etc/openclaw-railway/openclaw-slack-routing.patch'
check "the image defaults disposable inspection snapshots to container storage" \
  'docker run --rm --entrypoint node "$image" -e '"'"'
    require("node:assert/strict").equal(process.env.XDG_CACHE_HOME, "/tmp");
  '"'"''

check "runtime contains exactly the rebuilt artifacts and production plugin links" \
  'docker run --rm --entrypoint node "$image" -e '"'"'
    const fs = require("node:fs");
    const assert = require("node:assert/strict");
    const expected = JSON.parse(fs.readFileSync("/app/openclaw-build-files.json", "utf8"));
    const actual = fs.readdirSync("/app/dist", { recursive: true }).toSorted();
    assert.deepEqual(actual, expected);
    for (const file of actual) {
      const pathname = "/app/dist/" + file;
      if (fs.lstatSync(pathname).isSymbolicLink()) assert.ok(fs.existsSync(pathname), "broken production dependency: " + file);
    }
  '"'"''

check "Control UI assets match the runtime build identity" \
  'docker run --rm --entrypoint node "$image" -e '"'"'
    const fs = require("node:fs");
    const runtime = JSON.parse(fs.readFileSync("/app/dist/build-info.json", "utf8"));
    const html = fs.readFileSync("/app/dist/control-ui/index.html", "utf8");
    const identity = html.match(/data-openclaw-control-ui-build-id="([a-zA-Z0-9._-]+)-[a-f0-9]{64}"/u)?.[1];
    if (!identity || identity !== runtime.buildId) throw new Error("Control UI build identity differs from runtime");
  '"'"''

log "bundled tools"
check "the GitHub CLI is installed for GitHub connections and runs as node" \
  'docker run --rm --user node --entrypoint gh "$image" --version | grep -E "^gh version [0-9]"'
for tool_check in "gog --version" "jq --version" "tmux -V" "codex --version" "claude --version" "command -v gog-login"; do
  check "$tool_check runs as node" 'docker run --rm --user node --entrypoint sh "$image" -c "$tool_check"'
done
# OpenClaw's image processor (Rastermill) can't decode HEIC itself and falls
# back to ImageMagick. tests/fixtures/gradient.heic is a generated 64x64 image.
check "OpenClaw's image processor converts an iPhone HEIC photo to JPEG" \
  'docker run --rm --user node -v "$PWD/tests/fixtures:/fixtures:ro" --entrypoint sh "$image" -c '"'"'
    rastermill="$(find /app/node_modules/.pnpm -path "*/rastermill@*/node_modules/rastermill/dist/index.js" -print -quit)"
    node --input-type=module -e "
      const { readFileSync } = await import(\"node:fs\");
      const { encode } = await import(process.argv[1]);
      const image = await encode(readFileSync(\"/fixtures/gradient.heic\"), { format: \"jpeg\", maxSide: 64 });
      if (image.mimeType !== \"image/jpeg\" || image.width !== 64) process.exit(1);
    " "$rastermill"'"'"''

log "no secrets in the image"
check "the image has no credentials in its environment" \
  '! docker image inspect -f "{{range .Config.Env}}{{println .}}{{end}}" "$image" | grep -Ei "^[A-Z_]*(TOKEN|SECRET|PASSWORD|AUTHKEY|AUTH_KEY|API_KEY)="'
check "the image has no credentials in its build history" \
  '! docker history --no-trunc --format "{{.CreatedBy}}" "$image" | grep -Ei "tskey-|sk-ant-|sk-proj-|GATEWAY_TOKEN="'
check "the Dockerfile declares no build args, so Railway variables never reach image layers" \
  '! grep -n "^ARG" Dockerfile'

log "environment validation"
expect_refusal() {
  description="$1"
  expected_message="$2"
  shift 2
  set +e
  output="$(docker run --rm "$@" "$image" 2>&1)"
  status=$?
  set -e
  check "$description" '[ "$status" = 64 ] && printf "%s" "$output" | grep -F "$expected_message"'
}
expect_refusal "refuses to start without OPENCLAW_GATEWAY_TOKEN" "OPENCLAW_GATEWAY_TOKEN is not set"
expect_refusal "refuses a short gateway token" "at least 32 characters" -e OPENCLAW_GATEWAY_TOKEN=short
expect_refusal "refuses a PORT that collides with the Gateway's loopback port" "Delete the PORT variable" \
  -e OPENCLAW_GATEWAY_TOKEN="$token" -e PORT=18789
expect_refusal "refuses to start as a non-root user it cannot prepare the volume with" "must start as root" \
  --user node -e OPENCLAW_GATEWAY_TOKEN="$token"
expect_refusal "refuses to start when Tailscale isn't logged in and TS_AUTHKEY is missing" "TS_AUTHKEY is not set" \
  -e OPENCLAW_GATEWAY_TOKEN="$token"
expect_refusal "reports a rejected auth key without printing it" "Tailscale login failed" \
  -e OPENCLAW_GATEWAY_TOKEN="$token" -e TS_AUTHKEY=tskey-auth-invalid-for-tests
check "the rejected auth key does not appear in the output" '! printf "%s" "$output" | grep -F tskey-auth-invalid-for-tests'
expect_refusal "refuses a display name with no letters or digits for the machine name, before logging in" "has no letters or digits" \
  -e OPENCLAW_GATEWAY_TOKEN="$token" -e TS_AUTHKEY=tskey-auth-invalid-for-tests -e OPENCLAW_MACHINE_DISPLAY_NAME=🦞
# A volume from the previous layout: a LAN-bound Gateway behind a separate
# Tailscale service, with gateway.publicOrigin and a device-pair publicUrl.
docker run --rm -v "$run_id-old-state:/data" --entrypoint sh "$image" -c '
  mkdir -p /data/.openclaw && node -e "
    const config = JSON.parse(require(\"node:fs\").readFileSync(\"/etc/openclaw-railway/openclaw.seed.json\", \"utf8\"));
    config.gateway.bind = \"lan\";
    config.gateway.tailscale.mode = \"off\";
    config.gateway.publicOrigin = \"\${OPENCLAW_PUBLIC_ORIGIN}\";
    config.plugins = { entries: { \"device-pair\": { config: { publicUrl: \"\${OPENCLAW_PUBLIC_ORIGIN}\" } } } };
    require(\"node:fs\").writeFileSync(\"/data/.openclaw/openclaw.json\", JSON.stringify(config));"' >/dev/null
expect_refusal "refuses a config from the previous two-service layout and names the migration" "openclaw config set gateway.bind loopback" \
  -v "$run_id-old-state:/data" -e OPENCLAW_GATEWAY_TOKEN="$token"

# OpenClaw's Gmail watcher would run `tailscale funnel` on port 443.
docker run --rm -v "$run_id-gmail-state:/data" --entrypoint sh "$image" -c '
  mkdir -p /data/.openclaw && node -e "
    const config = JSON.parse(require(\"node:fs\").readFileSync(\"/etc/openclaw-railway/openclaw.seed.json\", \"utf8\"));
    config.hooks = { gmail: { tailscale: { mode: \"funnel\" } } };
    require(\"node:fs\").writeFileSync(\"/data/.openclaw/openclaw.json\", JSON.stringify(config));"' >/dev/null
expect_refusal "refuses hooks.gmail.tailscale.mode funnel, which would publish port 443" "hooks.gmail.tailscale.mode is funnel" \
  -v "$run_id-gmail-state:/data" -e OPENCLAW_GATEWAY_TOKEN="$token"
relay_without_opt_in="$(docker run --rm -e OPENCLAW_RAILWAY_TEST_WITHOUT_TAILSCALE=1 -e OPENCLAW_GATEWAY_PORT=18789 --user node --entrypoint sh "$image" -c '
  node /usr/local/lib/openclaw-railway/sidecar.mjs & sleep 2
  node -e "fetch(\"http://127.0.0.1:8080/hooks/x\", { method: \"POST\" }).then((response) => console.log(response.status), () => console.log(\"unreachable\"))"')"
check "webhook routes are off (404) unless OPENCLAW_RAILWAY_WEBHOOKS is set" '[ "$relay_without_opt_in" = 404 ]'

log "first boot on an empty volume"
start_gateway
check "/startupz returns 200 through the health relay" 'wait_for_startup'
check "first boot completes full Doctor activation exactly once" \
  '[ "$(docker logs "$gateway" 2>&1 | grep -c "OpenClaw image activation: Doctor completed successfully")" = 1 ]'
activation_receipt="$(docker exec "$gateway" cat /data/.openclaw/railway-image-activation.json)"
check "activation is recorded in a private node-owned receipt" \
  '[ "$(docker exec "$gateway" stat -c "%U %a" /data/.openclaw/railway-image-activation.json)" = "node 600" ]'
check "the baseline config is written on first boot" \
  'docker logs "$gateway" 2>&1 | grep -F "created /data/.openclaw/openclaw.json from the baseline config"'
check "the config is in local mode with an env-referenced token" \
  '[ "$(gateway_cli config get gateway.mode)" = local ] && docker exec "$gateway" grep -q OPENCLAW_GATEWAY_TOKEN /data/.openclaw/openclaw.json'
check "the config binds the Gateway to loopback behind OpenClaw-managed Tailscale Serve" \
  '[ "$(gateway_cli config get gateway.bind)" = loopback ] && [ "$(gateway_cli config get gateway.tailscale.mode)" = serve ]'
check "the state directory is owned by node with mode 700" \
  '[ "$(docker exec "$gateway" stat -c "%U %a" /data/.openclaw)" = "node 700" ]'
check "nothing under /data is owned by root" '[ -z "$(root_owned_state)" ]'
check "tini is PID 1" 'docker exec "$gateway" ps -o args= -p 1 | grep -E "^tini "'
check "every container process runs as uid 1000 (node)" \
  '[ -z "$(docker top "$gateway" -eo pid,uid | tail -n +2 | awk "\$2 != 1000")" ]'
check "the gateway token does not appear in any process arguments" \
  '! docker top "$gateway" -eo pid,args | grep -F "$token"'

log "network exposure"
check "/healthz returns 200 through the relay" '[ "$(remote_status /healthz)" = 200 ]'
check "/startupz accepts Railway's healthcheck.railway.app Host header" \
  '[ "$(remote_status /startupz host=healthcheck.railway.app)" = 200 ]'
check "/readyz returns 200 with no channels configured" '[ "$(remote_status /readyz)" = 200 ]'
check "HEAD on a probe path is relayed" '[ "$(METHOD=HEAD remote_status /healthz)" = 200 ]'
for path in / /control-ui-config.json /v1/models /healthz/../v1/models /%68ealthz; do
  check "the relay refuses $path (404)" '[ "$(remote_status "$path")" = 404 ]'
done
check "the relay refuses POST to a probe path (404)" '[ "$(METHOD=POST remote_status /healthz)" = 404 ]'
check "the Gateway's own port is unreachable from the network" '[ "$(PORT=18789 remote_status /healthz)" = unreachable ]'

log "authentication on the loopback listener"
check "an unauthenticated request is rejected (401)" '[ "$(local_status /control-ui-config.json)" = 401 ]'
check "a wrong token is rejected (401)" \
  '[ "$(local_status /control-ui-config.json "authorization=Bearer wrong-token-000000000000000000000000")" = 401 ]'
check "the token is accepted (200)" '[ "$(local_status /control-ui-config.json "authorization=Bearer $token")" = 200 ]'
# Only OpenClaw's managed Serve listener accepts Tailscale identity; forwarded
# headers on the ordinary listener fail proxy attribution, even with the token.
check "spoofed Tailscale identity headers are rejected by proxy attribution (403)" \
  '[ "$(local_status /control-ui-config.json tailscale-user-login=someone@example.com x-forwarded-for=100.64.0.9 x-forwarded-proto=https x-forwarded-host=openclaw.example-tailnet.ts.net)" = 403 ]'
check "forwarded headers are rejected even with the token (403)" \
  '[ "$(local_status /control-ui-config.json "authorization=Bearer $token" x-forwarded-for=100.64.0.9)" = 403 ]'

log "updatable tools layer"
check "Homebrew is seeded onto the volume on first boot" \
  'docker logs "$gateway" 2>&1 | grep -F "created /data/linuxbrew from the image" && docker exec "$gateway" test -x /data/linuxbrew/bin/brew'
check "brew runs from a root shell (as node) with the standard prefix" \
  '[ "$(docker exec "$gateway" brew --prefix)" = /home/linuxbrew/.linuxbrew ]'
check "npm install -g targets the volume" \
  '[ "$(docker exec "$gateway" as-node npm config get prefix)" = /data/home/.local ]'
docker exec "$gateway" as-node sh -c 'mkdir -p "$HOME/.local/bin" && for tool in gog openclaw; do printf "#!/bin/sh\necho volume-copy\n" > "$HOME/.local/bin/$tool"; chmod +x "$HOME/.local/bin/$tool"; done'
check "a tool on the volume takes precedence over the image's copy" \
  '[ "$(docker exec "$gateway" as-node sh -c "command -v gog")" = /data/home/.local/bin/gog ]'
check "the OpenClaw CLI can't be shadowed from the volume" \
  '[ "$(docker exec "$gateway" as-node sh -c "command -v openclaw")" = /usr/local/sbin/openclaw ]'
docker exec "$gateway" as-node rm -f /data/home/.local/bin/gog /data/home/.local/bin/openclaw

log "security audit"
# Prints "<severity> <checkId>" for every critical or warning finding.
audit_problems() {
  gateway_cli security audit --json 2>/dev/null | docker run --rm -i --entrypoint node "$image" -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      for (const finding of JSON.parse(input).findings) {
        if (finding.severity !== "info") console.log(`${finding.severity} ${finding.checkId}`);
      }
    });'
}
# gateway.trusted_proxies_missing fires for every loopback Gateway without
# trustedProxies, including OpenClaw's own Serve setup; trusting 127.0.0.1 to
# silence it would trust every process in the container. See SECURITY.md.
check "the security audit has no critical findings and no warnings beyond trusted_proxies_missing" \
  '[ "$(audit_problems)" = "warn gateway.trusted_proxies_missing" ]'

log "webhook routes on PORT (public only with a Railway domain)"
gateway_cli config set hooks.enabled true >/dev/null 2>&1
gateway_cli config set hooks.token '${OPENCLAW_HOOKS_TOKEN}' >/dev/null 2>&1
gateway_cli config set hooks.allowedAgentIds '["main"]' --strict-json >/dev/null 2>&1
attempt=0
until [ "$(relay_status /hooks/wake "authorization=Bearer $hooks_token")" = 200 ] || [ "$attempt" -ge 20 ]; do
  sleep 1
  attempt=$((attempt + 1))
done
check "a hook with the token in an Authorization header reaches the Gateway (200)" \
  '[ "$(relay_status /hooks/wake "authorization=Bearer $hooks_token")" = 200 ]'
check "a hook with the token in x-openclaw-token reaches the Gateway (200)" \
  '[ "$(relay_status /hooks/wake "x-openclaw-token=$hooks_token")" = 200 ]'
check "a hook with the token as the last path segment reaches the Gateway (200)" \
  '[ "$(relay_status "/hooks/wake/$hooks_token")" = 200 ]'
check "a hook without the token is refused by the relay (401)" '[ "$(relay_status /hooks/wake)" = 401 ]'
check "a hook with a wrong path token is refused (401)" '[ "$(relay_status /hooks/wake/not-the-token)" = 401 ]'
check "spoofed forwarded and Tailscale identity headers are stripped, not trusted (200)" \
  '[ "$(relay_status /hooks/wake "authorization=Bearer $hooks_token" tailscale-user-login=someone@example.com x-forwarded-for=100.64.0.9)" = 200 ]'
check "GET is refused (404)" '[ "$(METHOD=GET relay_status /hooks/wake)" = 404 ]'
for path in / /control-ui-config.json /v1/models; do
  check "the relay refuses $path (404)" '[ "$(relay_status "$path" "authorization=Bearer $hooks_token")" = 404 ]'
done
check "the relay refuses a path that climbs out of /hooks (404)" \
  '[ "$(relay_status "/hooks/../control-ui-config.json/$hooks_token")" = 404 ]'
check "a body over 1 MiB is refused (413)" \
  '[ "$(BODY_BYTES=2000000 relay_status /hooks/wake "authorization=Bearer $hooks_token")" = 413 ]'
for attempt in $(seq 1 20); do relay_status /hooks/wake x-forwarded-for=203.0.113.7 >/dev/null; done
check "20 failures from one caller lock that caller out (429)" \
  '[ "$(relay_status /hooks/wake x-forwarded-for=203.0.113.7 "authorization=Bearer $hooks_token")" = 429 ]'
check "other callers are not locked out" \
  '[ "$(relay_status /hooks/wake x-forwarded-for=198.51.100.2 "authorization=Bearer $hooks_token")" = 200 ]'
check "health checks still work alongside webhook routes" '[ "$(remote_status /healthz)" = 200 ]'

log "state survives a restart"
# /proc/1/environ belongs to node, so read it as node.
check "HOME is on the volume for the Gateway" \
  'docker exec "$gateway" as-node sh -c "tr \"\\0\" \"\\n\" < /proc/1/environ" | grep -x HOME=/data/home'
check "the machine display name defaults to the Tailscale machine name" \
  'docker exec "$gateway" as-node sh -c "tr \"\\0\" \"\\n\" < /proc/1/environ" | grep -x OPENCLAW_MACHINE_DISPLAY_NAME=openclaw'
check "the Tailscale machine name defaults to openclaw" \
  'docker exec "$gateway" as-node sh -c "tr \"\\0\" \"\\n\" < /proc/1/environ" | grep -x TS_HOSTNAME=openclaw'
check "the image turns a display name into a machine name (My Gateway -> my-gateway)" \
  '[ "$(docker exec "$gateway" node /usr/local/lib/openclaw-railway/tailscale-hostname.mjs "My Gateway")" = my-gateway ]'
check "the display-name patch is applied to OpenClaw's machine-name fallback" \
  'docker exec "$gateway" sh -c "grep -l OPENCLAW_MACHINE_DISPLAY_NAME /app/dist/machine-name-*.mjs"'
check "HOME is on the volume in a root shell too" '[ "$(docker exec "$gateway" sh -c "echo \$HOME")" = /data/home ]'
docker exec "$gateway" as-node sh -c 'echo kept > "$HOME/persist-check"'
gateway_cli config set gateway.controlUi.communityInvite false >/dev/null 2>&1
check "a config change made from a root shell leaves no root-owned files" '[ -z "$(root_owned_state)" ]'
docker exec "$gateway" touch /data/.openclaw/written-by-root /data/home/written-by-root /data/tailscale/written-by-root
start_time="$(date +%s)"
docker stop -t 60 "$gateway" >/dev/null
stop_seconds=$(($(date +%s) - start_time))
check "SIGTERM stops the Gateway cleanly (exit 0)" '[ "$(docker inspect -f "{{.State.ExitCode}}" "$gateway")" = 0 ]'
check "graceful stop finished in ${stop_seconds}s" '[ "$stop_seconds" -lt 30 ]'
docker start "$gateway" >/dev/null
check "the Gateway starts again on the same volume" 'wait_for_startup'
check "a routine restart admits state without repeating Doctor" \
  '[ "$(docker logs "$gateway" 2>&1 | grep -c "OpenClaw image activation: Doctor completed successfully")" = 1 ] && [ "$(docker logs "$gateway" 2>&1 | grep -c "OpenClaw image activation unchanged: continuing to Gateway state admission")" = 1 ]'
check "a routine restart preserves the activation receipt" \
  '[ "$(docker exec "$gateway" cat /data/.openclaw/railway-image-activation.json)" = "$activation_receipt" ]'
check "the config change persisted" '[ "$(gateway_cli config get gateway.controlUi.communityInvite)" = false ]'
check "the baseline config was not reapplied" \
  '[ "$(docker logs "$gateway" 2>&1 | grep -c "from the baseline config")" = 1 ]'
check "OpenClaw did not detect a clobbered config" \
  '! docker exec "$gateway" sh -c "ls /data/.openclaw | grep clobbered"'
check "root-owned files are handed back to node on restart, including Tailscale state" \
  'for file in /data/.openclaw/written-by-root /data/home/written-by-root /data/tailscale/written-by-root; do [ "$(docker exec "$gateway" stat -c %U "$file")" = node ] || exit 1; done'
check "Homebrew survives a restart and isn't seeded again" \
  'docker exec "$gateway" brew --version && [ "$(docker logs "$gateway" 2>&1 | grep -c "created /data/linuxbrew")" = 1 ]'
check "files in HOME survive a restart" \
  '[ "$(docker exec "$gateway" cat /data/home/persist-check)" = kept ]'

log "crash handling"
docker exec "$gateway" pkill -KILL -f openclaw-gateway || true
attempt=0
until [ "$(docker inspect -f '{{.State.Running}}' "$gateway")" = false ] || [ "$attempt" -ge 15 ]; do
  sleep 1
  attempt=$((attempt + 1))
done
check "the container exits when the Gateway dies, so Railway's restart policy applies" \
  '[ "$(docker inspect -f "{{.State.Running}}" "$gateway")" = false ]'
check "the crash exit code is non-zero" '[ "$(docker inspect -f "{{.State.ExitCode}}" "$gateway")" != 0 ]'
docker start "$gateway" >/dev/null
check "the Gateway recovers after a crash" 'wait_for_startup'
check "crash recovery admits state without repeating Doctor" \
  '[ "$(docker logs "$gateway" 2>&1 | grep -c "OpenClaw image activation: Doctor completed successfully")" = 1 ] && [ "$(docker logs "$gateway" 2>&1 | grep -c "OpenClaw image activation unchanged: continuing to Gateway state admission")" = 2 ]'
check "crash recovery preserves the activation receipt" \
  '[ "$(docker exec "$gateway" cat /data/.openclaw/railway-image-activation.json)" = "$activation_receipt" ]'

log "state survives container replacement"
docker rm -f "$gateway" >/dev/null
start_gateway
check "a replacement container admits the existing volume" 'wait_for_startup'
check "container replacement reuses activation without repeating Doctor" \
  '! docker logs "$gateway" 2>&1 | grep -q "OpenClaw image activation: Doctor completed successfully" && [ "$(docker logs "$gateway" 2>&1 | grep -c "OpenClaw image activation unchanged: continuing to Gateway state admission")" = 1 ]'
check "container replacement preserves the activation receipt" \
  '[ "$(docker exec "$gateway" cat /data/.openclaw/railway-image-activation.json)" = "$activation_receipt" ]'
check "container replacement preserves configuration and HOME files" \
  '[ "$(gateway_cli config get gateway.controlUi.communityInvite)" = false ] && [ "$(docker exec "$gateway" cat /data/home/persist-check)" = kept ]'

# The sidecar under tini, as in the real container, with tailscaled logged out.
docker run -d --name "$watchdog" --user node -e TS_STATE_DIR=/tmp/tailscale -e TS_SOCKET=/tmp/tailscaled.sock \
  -e OPENCLAW_GATEWAY_PORT=18789 --entrypoint tini "$image" -s -- node /usr/local/lib/openclaw-railway/sidecar.mjs >/dev/null
attempt=0
until docker exec "$watchdog" pgrep -x tailscaled >/dev/null 2>&1 || [ "$attempt" -ge 15 ]; do
  sleep 1
  attempt=$((attempt + 1))
done
docker exec "$watchdog" pkill -KILL -x tailscaled || true
attempt=0
until [ "$(docker inspect -f '{{.State.Running}}' "$watchdog")" = false ] || [ "$attempt" -ge 15 ]; do
  sleep 1
  attempt=$((attempt + 1))
done
check "the container stops when tailscaled dies, so Railway restarts both" \
  '[ "$(docker inspect -f "{{.State.Running}}" "$watchdog")" = false ] && docker logs "$watchdog" 2>&1 | grep -F "tailscaled exited"'

if [ -n "${TAILSCALE_TEST_AUTHKEY:-}" ]; then
  log "live: Tailscale Serve on a real tailnet"
  docker run -d --name "$live" -v "$run_id-live-state:/data" -e OPENCLAW_GATEWAY_TOKEN="$token" \
    -e TS_AUTHKEY="$TAILSCALE_TEST_AUTHKEY" -e OPENCLAW_MACHINE_DISPLAY_NAME="$live_display_name" "$image" >/dev/null
  attempt=0
  until docker logs "$live" 2>&1 | grep -qE "serve enabled|serve failed" || [ "$attempt" -ge 90 ]; do
    sleep 2
    attempt=$((attempt + 1))
  done
  check "the machine name comes from the display name ($live_display_name -> $live_hostname)" \
    'docker logs "$live" 2>&1 | grep -F "Tailscale machine name $live_hostname, from \"$live_display_name\""'
  check "the container logs in to the tailnet with TS_AUTHKEY" \
    'docker logs "$live" 2>&1 | grep -F "logged in to Tailscale as $live_hostname"'
  check "Tailscale is running" '[ "$(tailscale_field "$live" BackendState)" = Running ]'
  live_name="$(tailscale_field "$live" DNSName 2>/dev/null || true)"
  check "OpenClaw enables Serve at https://$live_name/" \
    'docker logs "$live" 2>&1 | grep -F "serve enabled: https://$live_name/"'
  check "the entrypoint logs the Gateway's tailnet address" \
    'docker logs "$live" 2>&1 | grep -F "the Gateway will be at https://$live_name/"'
  check "the auth key is not in the Gateway's environment" \
    '! docker exec -u node "$live" sh -c "tr \"\\0\" \"\\n\" < /proc/\$(pgrep -f openclaw-gateway | head -1)/environ" | grep -F TS_AUTHKEY'
  check "the auth key is not left in a file" '! docker exec "$live" grep -rlF "$TAILSCALE_TEST_AUTHKEY" /tmp /data'
  check "the auth key is not in the logs" '! docker logs "$live" 2>&1 | grep -F "$TAILSCALE_TEST_AUTHKEY"'
  check "mobile pairing QR advertises wss://$live_name with full access" \
    'docker exec "$live" openclaw qr --json | node -e "
      let input = \"\";
      process.stdin.on(\"data\", (chunk) => (input += chunk)).on(\"end\", () => {
        const setup = JSON.parse(input.slice(input.indexOf(\"{\")));
        process.exit(setup.gatewayUrl === \"wss://$live_name\" && setup.access === \"full\" ? 0 : 1);
      });"'
  if [ "${TAILSCALE_TEST_ON_TAILNET:-}" = 1 ]; then
    check "the dashboard answers over the tailnet at https://$live_name/" \
      '[ "$(curl -s -o /dev/null -w "%{http_code}" --max-time 60 "https://$live_name/healthz")" = 200 ]'
    # gog-login with a dummy Web client: Google is never contacted. A forged
    # callback over the tailnet must reach gog (which rejects its state) and
    # the temporary :8443 route must end with the command.
    docker exec -u node -e GOG_KEYRING_PASSWORD=test-password "$live" sh -c '
      printf "%s" "{\"web\":{\"client_id\":\"0-test.apps.googleusercontent.com\",\"client_secret\":\"test\",\"auth_uri\":\"https://accounts.google.com/o/oauth2/auth\",\"token_uri\":\"https://oauth2.googleapis.com/token\"}}" > /tmp/test-client.json
      gog auth keyring file && gog auth credentials /tmp/test-client.json && rm /tmp/test-client.json
      (timeout 90 gog-login someone@example.com --services gmail --no-input > /tmp/gog-login.out 2>&1 &)' >/dev/null 2>&1
    sleep 6
    check "gog-login prints the tailnet redirect URI" \
      'docker exec "$live" grep -F "https://$live_name:8443/oauth2/callback" /tmp/gog-login.out'
    check "a forged OAuth callback over the tailnet reaches gog and is rejected" \
      '[ "$(curl -s -o /dev/null -w "%{http_code}" --max-time 60 "https://$live_name:8443/oauth2/callback?code=forged&state=wrong")" = 400 ] && sleep 2 && docker exec "$live" grep -F "state mismatch" /tmp/gog-login.out'
    check "the temporary :8443 route ends with gog-login" \
      '[ "$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "https://$live_name:8443/oauth2/callback")" = 000 ]'
  fi
  # A second machine asking for the same name (TS_HOSTNAME, in capitals, which
  # the entrypoint lowercases) gets a suffixed name from Tailscale. The
  # entrypoint must report the name it got and the one it asked for, without
  # claiming why they differ.
  twin_requested="$(printf '%s' "$live_hostname" | tr '[:lower:]' '[:upper:]')"
  docker run -d --name "$live_twin" -v "$run_id-live-twin-state:/data" -e OPENCLAW_GATEWAY_TOKEN="$token" \
    -e TS_AUTHKEY="$TAILSCALE_TEST_AUTHKEY" -e TS_HOSTNAME="$twin_requested" "$image" >/dev/null
  attempt=0
  until docker logs "$live_twin" 2>&1 | grep -qE "serve enabled|serve failed|login failed" || [ "$attempt" -ge 90 ]; do
    sleep 2
    attempt=$((attempt + 1))
  done
  twin_name="$(tailscale_field "$live_twin" DNSName 2>/dev/null || true)"
  twin_machine="${twin_name%%.*}"
  check "a taken hostname is reported as the name Tailscale assigned ($twin_machine)" \
    '[ "$twin_machine" != "$live_hostname" ] && [ -n "$twin_machine" ] && docker logs "$live_twin" 2>&1 | grep -F "logged in to Tailscale as $twin_machine (asked for $live_hostname)" && ! docker logs "$live_twin" 2>&1 | grep -F "already taken"'
  check "the suffixed machine logs its own address and serves there" \
    'docker logs "$live_twin" 2>&1 | grep -F "the Gateway will be at https://$twin_name/" && docker logs "$live_twin" 2>&1 | grep -F "serve enabled: https://$twin_name/"'
  docker exec "$live_twin" as-node tailscale logout >/dev/null 2>&1 || true
  docker rm -f "$live_twin" >/dev/null 2>&1 || true
  docker restart "$live" >/dev/null
  attempt=0
  until [ "$(docker logs "$live" 2>&1 | grep -c "serve enabled")" -ge 2 ] || [ "$attempt" -ge 60 ]; do
    sleep 2
    attempt=$((attempt + 1))
  done
  check "after a restart, the saved login is reused (no second login)" \
    '[ "$(docker logs "$live" 2>&1 | grep -c "logged in to Tailscale")" = 1 ] && [ "$(docker logs "$live" 2>&1 | grep -c "serve enabled")" = 2 ]'
  check "every boot logs the Gateway's address, not only the first" \
    '[ "$(docker logs "$live" 2>&1 | grep -c "the Gateway will be at https://$live_name/")" = 2 ]'
  docker exec -u node "$live" sh -c 'kill -9 "$(pgrep -x tailscaled)"' || true
  attempt=0
  until [ "$(docker inspect -f '{{.State.Running}}' "$live")" = false ] || [ "$attempt" -ge 30 ]; do
    sleep 1
    attempt=$((attempt + 1))
  done
  check "killing tailscaled stops the whole container" '[ "$(docker inspect -f "{{.State.Running}}" "$live")" = false ]'
  docker start "$live" >/dev/null
  sleep 15
else
  log "live tier skipped (set TAILSCALE_TEST_AUTHKEY to a reusable, ephemeral Tailscale auth key to run it)"
fi

printf '\n'
if [ "$failures" -gt 0 ]; then
  printf '%s check(s) failed\n' "$failures"
  exit 1
fi
printf 'all checks passed\n'
