import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CURRENT_ENTRYPOINT = `#!/usr/bin/env node
import "./bin/executor.cjs";
`;

const LEGACY_ENTRYPOINT = `#!/usr/bin/env node
require("./executor.cjs");
`;

export const writeWrapperEntrypoints = async (
  wrapperDir: string,
  launcherSource: string,
): Promise<void> => {
  const binDir = join(wrapperDir, "bin");
  const legacyEntrypoint = join(binDir, "executor");
  const currentEntrypoint = join(wrapperDir, "bin.mjs");

  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "executor.cjs"), launcherSource);
  await writeFile(legacyEntrypoint, LEGACY_ENTRYPOINT);
  await writeFile(currentEntrypoint, CURRENT_ENTRYPOINT);
  await chmod(legacyEntrypoint, 0o755);
  await chmod(currentEntrypoint, 0o755);
};
