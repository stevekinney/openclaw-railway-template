// Checks documentation/RAILWAY_TEMPLATE.md, the source of the published
// template's readme. Railway strips anything that looks like an HTML tag when
// the readme is saved, so a placeholder such as <tailnet> silently disappears
// and leaves addresses like https://openclaw..ts.net on the public page.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const readme = await readFile(new URL("../documentation/RAILWAY_TEMPLATE.md", import.meta.url), "utf8");

// What Railway would publish: every <…> construct removed, including ones with
// spaces or attributes such as <your tailnet>.
const published = readme.replace(/<[^>]*>/g, "");

test("uses no angle-bracket construct Railway would strip", () => {
  assert.deepEqual(readme.match(/<[^>]*>/g) ?? [], []);
});

test("publishes no address left empty by a stripped placeholder", () => {
  assert.doesNotMatch(published, /\.\.ts\.net|\/\/\.ts\.net/);
});

test("names both variables the template asks for", () => {
  assert.match(readme, /`OPENCLAW_MACHINE_DISPLAY_NAME`/);
  assert.match(readme, /`TS_AUTHKEY`/);
});
