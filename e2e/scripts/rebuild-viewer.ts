// Re-render every player.html + the matrix index from the existing run.json
// files — re-skin the viewer without rerunning a single test.
// Usage: bun e2e/scripts/rebuild-viewer.ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { writePlayer } from "../src/viewer/render";
import { buildIndex } from "../src/viewer/index-builder";

const runsDir = fileURLToPath(new URL("../runs/", import.meta.url));

let count = 0;
for (const target of readdirSync(runsDir, { withFileTypes: true })) {
  if (!target.isDirectory()) continue;
  for (const slug of readdirSync(join(runsDir, target.name), { withFileTypes: true })) {
    if (!slug.isDirectory()) continue;
    const dir = join(runsDir, target.name, slug.name);
    const runPath = join(dir, "run.json");
    if (!existsSync(runPath)) continue;
    writePlayer(JSON.parse(readFileSync(runPath, "utf8")), dir);
    count++;
  }
}
buildIndex(runsDir);
console.log(`rebuilt ${count} players + index at ${runsDir}`);
