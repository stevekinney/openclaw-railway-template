// Turns a display name into the Tailscale machine name the entrypoint asks for,
// which becomes the first label of https://<name>.<tailnet>.ts.net:
// "Gowanus" -> gowanus, "My Gateway" -> my-gateway, "Café Bot!" -> cafe-bot.
//
// Accents are dropped, apostrophes removed, and every other run of characters
// outside a-z and 0-9 becomes one hyphen; the result is trimmed of hyphens and
// cut to 63 characters, the DNS label limit. Prints nothing and exits 1 when no
// letters or digits remain.
//
// Usage: node tailscale-hostname.mjs <name>
const name = String(process.argv[2] ?? "")
  .normalize("NFKD")
  .replace(/\p{M}/gu, "")
  .toLowerCase()
  .replace(/['’]/g, "")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 63)
  .replace(/-+$/, "");

if (!name) process.exit(1);
console.log(name);
