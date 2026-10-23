# Tailscale

Tailscale runs inside the `openclaw` container, and OpenClaw manages Tailscale
Serve itself (`gateway.tailscale.mode: serve`). The container joins your tailnet
as a machine named after the Gateway's display name. The Gateway is reachable at:

| Tailnet address | Transport | Served by |
| --- | --- | --- |
| `https://<machine-name>.<tailnet>.ts.net/` and `wss://<machine-name>.<tailnet>.ts.net` (port 443) | TLS terminated by Tailscale with the tailnet's Let's Encrypt certificate | OpenClaw-managed Serve, proxied to a dedicated loopback listener |

Two names appear throughout these guides:

- The **display name** is `OPENCLAW_MACHINE_DISPLAY_NAME`, the value the
  template asks for (`My Gateway`). OpenClaw's apps show it in their machine
  picker, as typed.
- The **machine name** is the Tailscale DNS label derived from it
  (`my-gateway`), and it is what `<machine-name>` stands for in addresses and
  commands. It is `TS_HOSTNAME` in the container, and it is chosen once, when
  Tailscale first logs in. Without a display name, both are `openclaw`.

There is no plaintext fallback port: the Gateway listens only on loopback, and
Serve needs tailnet HTTPS certificates. Browsers that reach the address sign in
with their Tailscale identity ([SECURITY.md](SECURITY.md#tailnet-identity-sign-in));
why forwarded headers can't be abused is in
[ARCHITECTURE.md](ARCHITECTURE.md#why-the-proxy-attribution-error-cannot-recur).

## Variables

| Variable | Set in | Value | Effect |
| --- | --- | --- | --- |
| `TS_AUTHKEY` | Railway (secret) | `tskey-auth-…` | Used only when the node is logged out: first boot, or after the machine was removed from the tailnet. Passed to `tailscale up` through a temporary file, then unset before the Gateway starts. |
| `OPENCLAW_MACHINE_DISPLAY_NAME` | Railway (the template asks) | e.g. `My Gateway` | The display name. The machine name requested at first login is derived from it: lowercased, accents dropped, and every other run of characters outside a–z and 0–9 turned into one hyphen, cut to 63 characters. Unset: `openclaw`. If the name is taken, Tailscale appends a suffix such as `-1`; nothing in the template depends on the name. |
| `TS_HOSTNAME` | Railway (optional) | e.g. `work-gateway` | The machine name. Overrides the one derived from the display name. Made into a DNS label the same way. |
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
       // drop it if you don't use gog. 32768-38768 is where OpenClaw portals
       // get their HTTPS ports (see Portals below); drop it if you don't use them.
       { "src": ["you@example.com"], "dst": ["tag:openclaw"], "ip": ["tcp:443", "tcp:8443", "tcp:32768-38768"] },
     ],
     "tests": [
       { "src": "you@example.com", "accept": ["tag:openclaw:443"] },
     ],
   }
   ```

   Merge this into your existing policy. If the policy still contains the
   default allow-all rule (`"src": ["*"], "dst": ["*:*"]` or the grants
   equivalent), every tailnet member can reach and sign in to the Gateway;
   narrow it. The Gateway's node gets no grants of its own, so it cannot open
   connections to anything else on your tailnet even if the Gateway is
   compromised. Only ports with a Serve route answer: the Gateway listens on
   loopback, so allowing the portal range exposes nothing until a portal opens.

   Also check who your policy lets use **Funnel**, which publishes a port on the
   public internet. A machine can use it only if the policy grants it the
   `funnel` node attribute, and new tailnets grant it to every member's
   machines:

   ```jsonc
   "nodeAttrs": [{ "target": ["autogroup:member"], "attr": ["funnel"] }]
   ```

   A tagged node isn't a member's machine, so this doesn't reach
   `tag:openclaw`; never add `tag:openclaw` to a `funnel` target. An untagged
   node is yours, so the default grant covers it: tag it, or narrow that target
   to the people who need Funnel. This is the only thing that keeps Funnel off
   (see [Operations](#operations)).

3. **Auth key**: create one under **Settings → Keys → Generate auth key**, with
   the settings below.

### Auth key settings

This is the one place these are explained; the other guides link here.

- **Reusable: off.** The key is used once; afterwards the node key on the
  volume logs the container in.
- **Ephemeral: off.** An ephemeral node is removed when it disconnects, for
  example during a redeploy.
- **Pre-approved: on** if your tailnet requires device approval. Otherwise the
  machine waits for you to approve it and the deploy fails its first boot.
- **Tags: `tag:openclaw`**, if your policy defines it (the policy above does).
  Tagged machines don't expire and get only the access your policy grants them.
- **Expiration: 1 day.** The key only has to last until the first deploy.
- **Key expiry of the machine.** An untagged machine belongs to your user and
  its node key expires after 180 days unless you disable key expiry for it in
  the admin console (**Machines → ⋯ → Disable key expiry**). When it expires the
  container is logged out and refuses to start until it gets a new `TS_AUTHKEY`.

## 2. Authenticate the node

Create the auth key with the [settings above](#auth-key-settings), then set it
on the service:

```bash
read -rs auth_key && printf '%s' "$auth_key" | railway variable set TS_AUTHKEY --stdin --service openclaw; unset auth_key
```

Without a key the container refuses to start: "Tailscale is not logged in … and
TS_AUTHKEY is not set." A rejected or expired key fails with Tailscale's own
error and "Tailscale login failed"; the key is never printed.

After the node joins, a consumed one-off key is useless; you can leave the variable or
delete it (then also remove it from `.railway/railway.ts` if you deploy with
IaC).

## 3. Verify

From a tailnet device allowed by the policy:

```bash
tailscale ping <machine-name>
curl -fsS https://<machine-name>.<tailnet>.ts.net/healthz   # {"ok":true,"status":"live"}
```

The first HTTPS request can take 15 seconds or more while Tailscale issues the
certificate (observed ≈15.6 s locally); later requests are fast. From a device
the policy does not allow, the same `curl` should time out. In the container,
the Gateway logs `[tailscale] serve enabled: https://<machine-name>.<tailnet>.ts.net/`
when Serve is up.

## Portals

[Portals](https://docs.openclaw.ai/gateway/portals) let an agent show you a
development server it runs on the Gateway (live reload included) in the
dashboard's **Portals** page (`https://<machine-name>.<tailnet>.ts.net/portals`).
They work with no extra setup, through OpenClaw-managed Serve:

- **Each portal gets its own HTTPS port** on the machine's tailnet address, for
  example `https://<machine-name>.<tailnet>.ts.net:35079/`. The port is an ephemeral
  port of the container, which on Railway is in **32768–38768** (checked
  2026-10-13 with `cat /proc/sys/net/ipv4/ip_local_port_range`; Docker's default
  elsewhere is 32768–60999). A restrictive access policy must allow that range,
  as in the grant above; otherwise portal URLs time out.
- **Access needs the portal's token**, which is in the link the agent and the
  dashboard give you. Tailnet identity doesn't grant access, and the token works
  for anyone who can reach the port, so treat portal links like passwords. The
  first request stores it in a cookie and strips it before the app sees it.
- **Portals end** when the agent closes them or the Gateway restarts (every
  redeploy). Closing a portal doesn't stop the development server; ask the agent
  to stop it.
- **Tool policy**: the `portal` tool comes with the `coding` and `full` tool
  profiles and is owner-only. A restricted agent such as the webhook reader
  (`minimal` profile) can't open portals. `tools.deny: ["portal"]` turns them off.
- **Not set up by the template**: OpenClaw's wildcard reverse-proxy ingress
  (`gateway.portals.ingress`) needs your own wildcard DNS, certificate, and a
  private edge; a Railway domain would make previews public. Managed Serve makes
  it unnecessary. Portals on node-backed cloud workers depend on the node, not
  on this deployment.

## Operations

- **Redeploys and restarts** keep the same node, address, and certificate: state
  is on the volume, and the entrypoint skips login when the node is already
  logged in (verified).
- **Inspecting Tailscale**: `railway ssh --service openclaw -- as-node tailscale status`.
  OpenClaw's Serve route is a foreground claim held by the Gateway, so
  `tailscale serve status` may show no persistent config while it is active.
- **Re-keying the node.** Remove the machine in the admin console,
  set a new `TS_AUTHKEY`, and redeploy. With the old identity revoked, the node
  is logged out, and the entrypoint uses the new key. (Verified when migrating
  production on 2026-10-08.)
- **Node key expiry.** See [auth key settings](#auth-key-settings): tag the
  machine or disable its key expiry, or it drops off the tailnet after 180 days.
- **Never enable Funnel** for this node. The `CMD` pins `--tailscale serve`, so
  OpenClaw itself never uses Funnel, but `tailscaled` runs as `node`, and so does
  anything the agent runs: `tailscale funnel` from the agent's shell would work
  if the tailnet allowed it. Nothing inside the container can prevent that, so
  the control is the `funnel` node attribute in your tailnet policy
  ([above](#1-prepare-the-tailnet)): keep it away from this node.
- **Upgrading Tailscale.** Dependabot proposes new `tailscale/tailscale` tags for
  the `FROM … AS tailscale` line in the `Dockerfile`; the image test checks the
  installed version matches the pin.
