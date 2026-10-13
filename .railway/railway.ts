// Railway Infrastructure as Code for this template: one service, one volume.
//
// Railway evaluates this file only when you run `railway config plan` or
// `railway config apply`; deploys never read it. See documentation/DEPLOYMENT.md.
//
// Secrets never appear here. Variables marked preserve() keep whatever value
// is already set in Railway, so set them with `railway variables` (or the
// dashboard) and list every variable you add to a service in this file.
import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

// The GitHub repository and branch Railway builds: your fork. Edit these, or
// export OPENCLAW_RAILWAY_REPOSITORY / OPENCLAW_RAILWAY_BRANCH before running
// the CLI. (globalThis.process may not exist in the CLI's evaluator.)
const environment = globalThis.process?.env ?? {};
const sourceRepository = environment.OPENCLAW_RAILWAY_REPOSITORY ?? "<github-owner>/<repository>";
const sourceBranch = environment.OPENCLAW_RAILWAY_BRANCH ?? "main";

// Where the service and its volume run. Declare the volume region and size
// explicitly: Railway fills them in when it creates a volume, and an undeclared
// value shows up in every later plan as a destructive change back to "unset".
const region = environment.OPENCLAW_RAILWAY_REGION ?? "us-west2";
const volumeSizeMB = 5000;

export default defineRailway(() => {
  if (sourceRepository.startsWith("<")) {
    throw new Error(
      "Set sourceRepository in .railway/railway.ts to your fork (owner/repository), or export OPENCLAW_RAILWAY_REPOSITORY.",
    );
  }

  const openclawState = volume("openclaw-state", { region, sizeMB: volumeSizeMB });
  // The Gateway and Tailscale share this container; Tailscale Serve, managed
  // by OpenClaw, is the only way in. No Railway domain or TCP proxy.
  const openclaw = service("openclaw", {
    source: github(sourceRepository, { branch: sourceBranch }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
      watchPatterns: ["Dockerfile", "config/**", "scripts/**", "tools/**"],
    },
    // OpenClaw runs one Gateway per state directory, and Railway cannot share a
    // volume between replicas: exactly one instance, in the volume's region.
    replicas: { [region]: 1 },
    deploy: {
      requiredMountPath: "/data",
      // /startupz is 200 once the Gateway admits traffic, which includes
      // Tailscale Serve being up. It ignores channel health, so a revoked
      // Telegram token cannot fail every deploy. The sidecar relays it from
      // PORT to the loopback-only Gateway.
      healthcheckPath: "/startupz",
      // Doctor runs migrations before the Gateway starts; upgrades can be slow.
      healthcheckTimeout: 600,
      // External supervisor mode restarts by exiting cleanly, so Railway must
      // restart on every exit, not only on failures.
      restartPolicyType: "ALWAYS",
      // Matches OpenClaw's own stop budget (315s drain + reserve + margin).
      drainingSeconds: 330,
    },
    volumeMounts: { "/data": openclawState },
    // No PORT variable: Railway then injects PORT=8080, where the sidecar
    // relays health checks.
    env: {
      OPENCLAW_GATEWAY_TOKEN: preserve(),
      // Used once, to log the container in to your tailnet on first boot.
      TS_AUTHKEY: preserve(),
      ANTHROPIC_API_KEY: preserve(),
      // The Gateway's name in OpenClaw's machine picker. The Tailscale machine
      // name, and so the tailnet address, is derived from it at first login
      // ("My Gateway" -> my-gateway); without it, both are openclaw.
      OPENCLAW_MACHINE_DISPLAY_NAME: preserve(),
      // Password for gog's token file; see documentation/TOOLS.md.
      GOG_KEYRING_PASSWORD: preserve(),
      // Opt-in webhooks; see documentation/WEBHOOKS.md.
      OPENCLAW_RAILWAY_WEBHOOKS: preserve(),
      OPENCLAW_HOOKS_TOKEN: preserve(),
      OPENCLAW_GMAIL_PUSH_TOKEN: preserve(),
    },
  });

  // Must match the project name given to `railway init --name`.
  return project("openclaw", {
    resources: [openclaw, openclawState],
  });
});
