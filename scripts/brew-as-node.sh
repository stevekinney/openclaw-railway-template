#!/bin/sh
# Homebrew refuses to run as root, and `railway ssh` opens a root shell. Run it
# as `node`, which owns the Homebrew prefix on the volume.
exec /usr/local/bin/as-node /home/linuxbrew/.linuxbrew/bin/brew "$@"
