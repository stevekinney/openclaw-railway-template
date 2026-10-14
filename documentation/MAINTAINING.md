# Maintaining

For whoever publishes and updates this repository's Railway template. Users
deploying the template, or deploying from their own fork, want
[QUICKSTART.md](QUICKSTART.md) or [DEPLOYMENT.md](DEPLOYMENT.md) instead.

## The Railway template

The published template is generated from a separate source project, not from a
live deployment, so no real secret can reach it. Railway's `templateGenerate`
keeps service names, sources, health-check paths, restart policy, volume mount
paths, and template *functions* such as `${{secret(64, "abcdef0123456789")}}`.
It **drops literal variable values**, marks every variable required, and drops
variable descriptions. That is why the service takes no `PORT` variable and
relies on Railway's default. The template asks for
`OPENCLAW_MACHINE_DISPLAY_NAME` (no default, so each deployment gets its own
machine name) and `TS_AUTHKEY`; it generates `OPENCLAW_GATEWAY_TOKEN`.

**The template's readme** (the text on the template page) lives in [RAILWAY_TEMPLATE.md](RAILWAY_TEMPLATE.md). Railway strips anything that looks like an HTML tag when it saves the readme, even inside backticks, so write placeholders as `your-tailnet`, never `<tailnet>`; `npm run test:railway-config` checks this. To publish a change to the readme, run from the repository root:

```bash
railway api 'mutation($id: String!, $i: TemplatePublishInput!) { templatePublish(id: $id, input: $i) { status } }' \
  --variables "$(jq -n --rawfile readme documentation/RAILWAY_TEMPLATE.md \
    '{id: "<template-id>", i: {category: "AI/ML", description: "Private OpenClaw Gateway, reachable only over your Tailscale tailnet", readme: $readme}}')"
```

`railway api 'query { template(code: "openclaw-private-gateway") { id readme } }'` prints the template's ID and shows the published readme afterwards.

**Small changes** (variables, descriptions, defaults): edit the published
template directly. Railway dashboard → workspace **Templates** → the template →
**Edit** → **Architecture**, open the service's **Variables**, make the change,
review **Details**, and **Apply**. Check the result with
`railway api 'query { template(code: "openclaw-private-gateway") { serializedConfig } }'`.

**Structural changes** (services, volumes, sources): regenerate. Running
`templateGenerate` on a project that already has a template **updates that
template in place**, even when it is published, and the published template's
original source project no longer exists. So:

1. In a scratch project whose service mirrors `.railway/railway.ts`, set
   `OPENCLAW_GATEWAY_TOKEN` to `${{ secret(64, "abcdef0123456789") }}` and
   placeholder values for `OPENCLAW_MACHINE_DISPLAY_NAME` and `TS_AUTHKEY`.
2. `railway api 'mutation($p: String!) { templateGenerate(input: { projectId: $p }) { id code serializedConfig } }' --variables '{"p":"<project-id>"}'`
3. Inspect `serializedConfig`: no secret values, one service, one volume at `/data`.
4. Deploy it into another scratch project
   (`railway deploy -t <code> -v openclaw.TS_AUTHKEY=…`, with a reusable,
   ephemeral key) and wait for `openclaw` to turn healthy.
5. Publish the new template (a new URL), add the variable descriptions for
   `OPENCLAW_MACHINE_DISPLAY_NAME` and `TS_AUTHKEY` in the template editor, point the README's Deploy button at it,
   and unpublish the old one.
