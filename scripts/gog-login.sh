#!/bin/sh
# Signs gog in to a Google account through the tailnet. Google redirects the
# browser to https://<this node>:8443/oauth2/callback, which a temporary
# Tailscale Serve route hands to gog on loopback; the route ends with this
# command. Needs a Google OAuth client of type "Web application" with that
# redirect URI registered (Desktop clients only allow 127.0.0.1 redirects).
#
# Usage: gog-login you@gmail.com --services gmail,calendar,drive
# Any `gog auth add` flags work, except the redirect ones this sets.
set -eu

# gog's tokens and Tailscale's socket belong to node.
[ "$(/usr/bin/id -u)" != 0 ] || exec /usr/local/bin/as-node "$0" "$@"

callback_port="${GOG_LOGIN_HTTPS_PORT:-8443}"
listen_port="${GOG_LOGIN_LISTEN_PORT:-8085}"
host="$(tailscale status --json | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk)).on("end", () => {
    console.log(JSON.parse(input).Self.DNSName.replace(/\.$/, ""));
  });')"

# Foreground route: it exists only while this process runs.
tailscale serve --yes --https="$callback_port" "http://127.0.0.1:$listen_port" >/dev/null &
serve_pid=$!
trap 'kill "$serve_pid" 2>/dev/null || true' EXIT INT TERM

printf 'Redirect URI (must be registered on your Web application OAuth client):\n  https://%s:%s/oauth2/callback\n\n' "$host" "$callback_port"
gog auth add "$@" --listen-addr "127.0.0.1:$listen_port" --redirect-host "$host:$callback_port"
