// OpenClaw 2026.10.3 uses os.hostname() for the Gateway picker label.
// Railway assigns a deployment-specific container hostname. Patch only this
// display-name fallback; fail the image build if an upgrade changes its shape.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const directory = "/app/dist";
const marker = /^[ \t]*return fallbackHostName\(\);$/gm;
const replacement = "return process.env.OPENCLAW_MACHINE_DISPLAY_NAME || fallbackHostName();";
const matches = readdirSync(directory).filter((name) => /^machine-name-.*\.mjs$/.test(name));
let patched = 0;
for (const name of matches) {
  const path = `${directory}/${name}`;
  const source = readFileSync(path, "utf8");
  const occurrences = [...source.matchAll(marker)];
  if (occurrences.length === 0) continue;
  if (occurrences.length !== 1) throw new Error(`Unexpected machine-name shape: ${name}`);
  writeFileSync(path, source.replace(marker, `\t\t${replacement}`));
  patched += 1;
}
if (patched !== 1) throw new Error(`Expected one OpenClaw machine-name implementation; patched ${patched}`);
