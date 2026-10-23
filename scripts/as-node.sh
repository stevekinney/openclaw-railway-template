#!/bin/sh
# Runs a command as `node`, the Gateway's user, in node's environment: HOME and
# tools on the volume. The entrypoint starts the Gateway and the sidecar with
# it; in a `railway ssh` root shell, it keeps tool logins from leaving files the
# agent can't read.
# Usage: as-node gog auth list
#
# Root's environment (the image's ENV) keeps HOME and PATH off the volume. node,
# and so the agent, can write there: a root shell that found ls in
# /data/home/.local/bin, or read /data/home/.bashrc, would run the agent's code
# as root. Absolute paths below for the same reason.
#
# node's PATH, first match wins:
#   /usr/local/sbin          openclaw and brew wrappers; the OpenClaw CLI always
#                            matches the image's Gateway and can't be shadowed
#   /data/home/.local/bin    your tools on the volume: npm -g, Claude Code's
#                            self-updating native install
#   /home/linuxbrew/...      Homebrew on the volume
#   /usr/local/bin, ...      the image's pinned baseline
# NPM_CONFIG_PREFIX sends `npm install -g` to the volume instead of root-owned
# /usr/local.
#
# --no-new-privs: setuid programs in the base image (su, mount, passwd) can't
# raise privileges again. The capability flags drop what root had, so nothing
# started here can regain it.
node_path=/usr/local/sbin:/data/home/.local/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/home/node/.local/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
if [ "$(/usr/bin/id -u)" = 0 ]; then
  exec /usr/bin/setpriv --reuid=node --regid=node --init-groups --no-new-privs --inh-caps=-all --bounding-set=-all -- \
    /usr/bin/env -u TS_AUTHKEY HOME=/data/home NPM_CONFIG_PREFIX=/data/home/.local PATH="$node_path" "$@"
fi
exec /usr/bin/env HOME=/data/home NPM_CONFIG_PREFIX=/data/home/.local PATH="$node_path" "$@"
