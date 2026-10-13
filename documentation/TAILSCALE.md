# Tailscale

Tailscale runs inside the `openclaw` container, and OpenClaw manages Tailscale
Serve itself (`gateway.tailscale.mode: serve`). The container joins your tailnet
as a machine named after the Gateway's name (`OPENCLAW_MACHINE_DISPLAY_NAME`,
which the template asks for: `My Gateway` → `my-gateway`), or `openclaw` without
one. The examples here use `openclaw`. The Gateway is reachable at:

| Tailnet address | Transport | Served by |
| --- | --- | --- |
| `https://openclaw.<tailnet>.ts.net/` and `wss://openclaw.<tailnet>.ts.net` (port 443) | TLS terminated by Tailscale with the tailnet's Let's Encrypt certificate | OpenClaw-managed Serve, proxied to a dedicated loopback listener |

There is no plaintext fallback port: the Gateway listens only on loopback, and
Serve needs tailnet HTTPS certificates. Browsers that reach the address sign in
with their Tailscale identity ([SECURITY.md](SECURITY.md#tailnet-identity-sign-in));
why forwarded headers can't be abused is in
[ARCHITECTURE.md](ARCHITECTURE.md#why-the-proxy-attribution-error-cannot-recur).

## Variables

| Variable | Set in | Value | Effect |
| --- | --- | --- | --- |
| `TS_AUTHKEY` | Railway (secret) | `tskey-auth-…` | Used only when the node is logged out: first boot, or after the machine was removed from the tailnet. Passed to `tailscale up` through a temporary file, then unset before the Gateway starts. |
| `OPENCLAW_MACHINE_DISPLAY_NAME` | Railway (the template asks) | e.g. `My Gateway` | The machine name requested at first login is derived from it: lowercased, accents dropped, and every other run of characters outside a–z and 0–9 turned into one hyphen, cut to 63 characters. Unset: `openclaw`. If the name is taken, Tailscale appends a suffix such as `-1`; nothing in the template depends on the name. |
| `TS_HOSTNAME` | Railway (optional) | e.g. `openclaw` | Overrides the derived machine name. Made into a DNS label the same way. |
| `TS_STATE_DIR` | image | `/data/tailscale` | Node key, identity, and certificates, on the service's volume. |
| `TS_SOCKET` | image | `/var/run/tailscale/tailscaled.sock` | The CLI's default path, so `tailscale` and OpenClaw find the daemon without flags. |
| `TS_DEBUG_MTU` | image | `1236` | Tunnel MTU. Railway's network interface has a 1316-byte MTU, and a full Tailscale packet is 1280 plus 80 bytes of WireGuard overhead, so larger packets were lost: TLS handshakes took 0.6–1.7 s and transfers ran near 10 KB/s. 1236 = 1316 − 80. Measured after the change (previous layout): 65–75 ms handshakes, a 20 KB page in 0.25 s. *Not yet re-measured on Railway with Tailscale in this container.* This is a debug knob in Tailscale, so re-check it when upgrading Tailscale. |

`tailscaled` runs as `node` in userspace mode (no `/dev/net/tun`, no
`NET_ADMIN`), started by `scripts/sidecar.mjs`. If it exits, the sidecar stops
the container so Railway restarts everything
([ARCHITECTURE.md](ARCHITECTURE.md#the-sidecar)).

## 1. Prepare the tailnet

In the [admin console](https://login.tailscale.com/admin):

1. **DNS**: enable MagicDNS and **HTTPS Certificates**. Both are required.
2. **Access controls**: add a tag owner and a grant that lets only you reach the
   Gateway. With tailnet identity sign-in, this policy is also who can open the
   dashboard. Replace `you@example.com`:

   ```jsonc
   {
     "tagOwners": {
       "tag:openclaw": ["autogroup:admin"],
     },
     "grants": [
       // Only the operator's devices may reach the Gateway, and only HTTPS.
       // 8443 is gog-login's temporary Google sign-in callback (TOOLS.md);
       // drop it if you don't use gog.
       { "src": ["you@example.com"], "dst": ["tag:openclaw"], "ip": ["tcp:443", "tcp:8443"] },
     ],
     "tests": [
       { "src": "you@example.com", "accept": ["tag:openclaw:443"] },
     ],
   }
   ```

   Merge this into your existing policy. If the policy still contains the
   default allow-all rule (`"src": ["*"], "dst": ["*:*"]` or the grants
   equivalent), every tailnet member can reach and sign in to the Gateway;
   narrow it. The `openclaw` node gets no grants of its own, so it cannot open
   connections to anything else on your tailnet even if the Gateway is
   compromised. If you use OpenClaw portals, they allocate further Serve HTTPS
   ports that the grant must also allow.

## 2. Authenticate the node

**Settings → Keys → Generate auth key**:

- Reusable: **off**. The key is used once; afterwards the identity lives on the
  volume.
- Expiration: 1 day. It only needs to last until the first deploy.
- Ephemeral: **off**. An ephemeral node would be removed when it disconnects
  (for example during a redeploy).
- Pre-approved: **on** if your tailnet requires device approval.
- Tags: `tag:openclaw`.

```bash
read -rs auth_key && printf '%s' "$auth_key" | railway variable set TS_AUTHKEY --stdin --service openclaw; unset auth_key
```

Without a key the container refuses to start: "Tailscale is not logged in … and
TS_AUTHKEY is not set." A rejected or expired key fails with Tailscale's own
error and "Tailscale login failed"; the key is never printed.

Tagged nodes have key expiry disabled by default, so the node stays logged in.
After it joins, a consumed one-off key is useless; you can leave the variable or
delete it (then also remove it from `.railway/railway.ts` if you deploy with
IaC).

## 3. Verify

From a tailnet device allowed by the policy:

```bash
tailscale ping openclaw
curl -fsS https://openclaw.<tailnet>.ts.net/healthz   # {"ok":true,"status":"live"}
```

The first HTTPS request can take 15 seconds or more while Tailscale issues the
certificate (observed ≈15.6 s locally); later requests are fast. From a device
the policy does not allow, the same `curl` should time out. In the container,
the Gateway logs `[tailscale] serve enabled: https://openclaw.<tailnet>.ts.net/`
when Serve is up.

## Operations

- **Redeploys and restarts** keep the same node, address, and certificate: state
  is on the volume, and the entrypoint skips login when the node is already
  logged in (verified).
- **Inspecting Tailscale**: `railway ssh --service openclaw -- as-node tailscale status`.
  OpenClaw's Serve route is a foreground claim held by the Gateway, so
  `tailscale serve status` may show no persistent config while it is active.
- **Re-keying the node.** Remove the `openclaw` machine in the admin console,
  set a new `TS_AUTHKEY`, and redeploy. With the old identity revoked, the node
  is logged out, and the entrypoint uses the new key. (Verified when migrating
  production on 2026-10-08.)
- **Node key expiry.** Tagged nodes don't expire by default. If you didn't tag
  the node, disable key expiry in the admin console or it will drop off the
  tailnet after the tailnet's expiry period (180 days by default); the container
  then refuses to start until it gets a new `TS_AUTHKEY`.
- **Never enable Funnel** for this node. OpenClaw's Funnel mode would make the
  Gateway public; the `CMD` pins `--tailscale serve`.
- **Upgrading Tailscale.** Dependabot proposes new `tailscale/tailscale` tags for
  the `FROM … AS tailscale` line in the `Dockerfile`; the image test checks the
  installed version matches the pin.
