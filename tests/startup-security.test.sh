#!/bin/sh
# Exercise the root startup boundary in disposable containers, without a tailnet.
set -eu
image="${1:-openclaw-railway:test}"
failures=0

if ! docker run --rm -i --network none --entrypoint /bin/sh \
  -e OPENCLAW_GATEWAY_TOKEN=security-regression-token-000000000000 \
  -e OPENCLAW_RAILWAY_TEST_WITHOUT_TAILSCALE=1 "$image" -s <<'CONTAINER'
set -eu
/usr/bin/install -d -o node -g node /data /data/home /data/home/.local/bin /data/linuxbrew
/usr/bin/setpriv --reuid=node --regid=node --init-groups -- /bin/sh -s <<'ATTACKER'
for command in node id; do
  cat > "$HOME/.local/bin/$command" <<'WRAPPER'
#!/bin/sh
if [ "$(/usr/bin/id -u)" = 0 ]; then
  /usr/bin/touch /data/root-command-executed
fi
case "$0" in
  */node) exec /usr/local/bin/node "$@" ;;
  */id) exec /usr/bin/id "$@" ;;
esac
WRAPPER
  chmod 755 "$HOME/.local/bin/$command"
done
ATTACKER
/usr/local/bin/openclaw-railway-entrypoint /bin/sh -c '
  test "$(id -u)" = 1000
  test "$(command -v node)" = /data/home/.local/bin/node
  node --version
'
test ! -e /data/root-command-executed
printf 'ok: volume executables run only after dropping root\n'
CONTAINER
then
  printf 'FAIL: root startup executed a volume-installed command\n' >&2
  failures=$((failures + 1))
fi

for directory in /data/.openclaw /data/home /data/tailscale /data/linuxbrew /data/redirected; do
  if ! docker run --rm -i --network none --entrypoint /bin/sh \
    -e OPENCLAW_GATEWAY_TOKEN=security-regression-token-000000000000 \
    -e OPENCLAW_RAILWAY_TEST_WITHOUT_TAILSCALE=1 "$image" -s -- "$directory" <<'CONTAINER'
set -eu
/usr/bin/install -d -o node -g node /data
/usr/bin/setpriv --reuid=node --regid=node --init-groups -- /bin/ln -s /etc "$1"
if [ "$1" = /data/redirected ]; then
  export TS_STATE_DIR=/data/redirected/tailscale
fi
before="$(/usr/bin/stat -c '%u:%g:%a' /etc)"
set +e
/usr/local/bin/openclaw-railway-entrypoint /usr/bin/true > /tmp/startup-output 2>&1
status=$?
set -e
test "$status" = 64
/usr/bin/grep -F 'symbolic link' /tmp/startup-output
test "$(/usr/bin/stat -c '%u:%g:%a' /etc)" = "$before"
test ! -e /etc/openclaw.json
printf 'ok: rejects %s symlink before mutating /etc\n' "$1"
CONTAINER
  then
    printf 'FAIL: unsafe startup with symlink at %s\n' "$directory" >&2
    failures=$((failures + 1))
  fi
done

test "$failures" = 0
