#!/bin/sh
# Sourced by image.test.sh; exercises public webhook isolation on its network.
# check() evaluates assertions later.
# shellcheck disable=SC2016

: "${network:?}" "${image:?}" "${gateway:?}" "${hooks_token:?}" "${locked_caller:?}"

# Keep one caller's socket address stable while testing lockouts.
relay_node() {
  if [ -n "${RELAY_CALLER:-}" ]; then
    docker exec "$RELAY_CALLER" node "$@"
  else
    docker run --rm --network "$network" --entrypoint node "$image" "$@"
  fi
}

# Prints the status of a request to the webhook routes on PORT (8080), made from
# another container on the network, the way Railway's edge delivers it when the
# service has a domain. Extra arguments are name=value request headers; METHOD
# overrides POST and BODY_BYTES sends a body of that many bytes.
relay_status() {
  path="$1"
  shift
  relay_node -e '
    const [method, url, size, ...pairs] = process.argv.slice(1);
    const headers = { "content-type": "application/json", ...Object.fromEntries(pairs.map((pair) => pair.split(/=(.*)/s).slice(0, 2))) };
    const body = method === "POST" ? (Number(size) > 0 ? "x".repeat(Number(size)) : JSON.stringify({ text: "relay test", mode: "next-heartbeat", agentId: "main" })) : undefined;
    fetch(url, { method, headers, body }).then((response) => console.log(response.status), () => console.log("unreachable"));
  ' "${METHOD:-POST}" "http://$(container_address "$gateway"):8080$path" "${BODY_BYTES:-0}" "$@"
}

run_webhook_image_checks() {
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
  docker run -d --name "$locked_caller" --network "$network" --user node --entrypoint sleep "$image" infinity >/dev/null
  for attempt in $(seq 1 20); do (RELAY_CALLER="$locked_caller" relay_status /hooks/wake x-forwarded-for=203.0.113.7) >/dev/null; done
  check "20 failures from one caller lock that caller out (429)" \
    '[ "$(RELAY_CALLER="$locked_caller" relay_status /hooks/wake x-forwarded-for=203.0.113.7 "authorization=Bearer $hooks_token")" = 429 ]'
  check "changing forged forwarding headers cannot bypass a lockout (429)" \
    '[ "$(RELAY_CALLER="$locked_caller" relay_status /hooks/wake x-real-ip=198.51.100.2 x-forwarded-for=198.51.100.2 "authorization=Bearer $hooks_token")" = 429 ]'
  check "other callers are not locked out" \
    '[ "$(RELAY_CALLER= relay_status /hooks/wake x-forwarded-for=198.51.100.2 "authorization=Bearer $hooks_token")" = 200 ]'
  check "health checks still work alongside webhook routes" '[ "$(remote_status /healthz)" = 200 ]'
}
