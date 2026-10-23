#!/bin/sh
# `railway ssh` opens a root shell. Run the OpenClaw CLI as `node` so anything it
# writes to the state volume stays readable by the Gateway.
exec /usr/local/bin/as-node /usr/local/bin/openclaw "$@"
