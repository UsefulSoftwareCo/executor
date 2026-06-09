// Render a Run into its self-contained player.html (next to its evidence
// files). The player is the primary review artifact: open it, watch the
// scenario replay, judge correctness without running anything locally.
// `?instant` skips the animation for fast review.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Run } from "../schema";

const templatePath = fileURLToPath(new URL("./player.template.html", import.meta.url));

export const renderPlayer = (run: Run): string =>
  readFileSync(templatePath, "utf8").replace("__RUN__", () => JSON.stringify(run));

export const writePlayer = (run: Run, dir: string): void => {
  writeFileSync(join(dir, "player.html"), renderPlayer(run));
};
