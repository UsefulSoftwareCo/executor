/**
 * Preflight for the packaged app's static build inputs (`apps/desktop/build/`).
 *
 * electron-builder resolves `directories.buildResources` and `mac.entitlements`
 * lazily, deep inside packaging, so a missing file there is silent until it is
 * far too late. When `build/entitlements.mac.plist` is absent the mac legs run
 * for ~8 minutes and then die inside codesign with
 * `build/entitlements.mac.plist: cannot read entitlement data`, naming an
 * arbitrary `*.lproj/locale.pak` — the first leaf codesign happened to reach,
 * not the actual problem. A missing `build/icon.png` never fails at all:
 * electron-builder logs `default Electron icon is used` and ships a generic
 * Electron app.
 *
 * These files are load-bearing but unreferenced: nothing in the repo imports
 * them, so deleting them breaks no build, type, or test. That is how the v1.6.1
 * tag was cut without them. This check gives them a reference. It runs in the
 * desktop unit tests on every PR, and again in publish-desktop.yml before
 * electron-builder starts, so the failure names the real cause in seconds.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import config from "../electron-builder.config";

// `import.meta.url` rather than Bun's `import.meta.dir`: this module is also
// imported by Vitest, which serves it through Vite's transform where the Bun
// property is undefined.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const buildResources = config.directories?.buildResources ?? "build";

const requiredPaths = (): readonly string[] => {
  const paths = new Set<string>();

  // electron-builder finds the app icon by convention
  // (`<buildResources>/icon.png`) rather than from a config field, so there is
  // no value to read here — the convention has to be spelled out.
  paths.add(`${buildResources}/icon.png`);

  const mac = config.mac;
  for (const entitlements of [mac?.entitlements, mac?.entitlementsInherit]) {
    if (typeof entitlements === "string") paths.add(entitlements);
  }

  return [...paths].sort();
};

const isPlistShaped = (text: string): boolean =>
  text.includes("<plist") && text.includes("</plist>") && text.includes("<dict>");

/**
 * Returns one human-readable problem per broken build input, or an empty array
 * when every input is present and usable. Never throws: callers decide whether
 * a problem is a failed assertion or a non-zero exit.
 */
export const checkBuildResources = async (): Promise<readonly string[]> => {
  const problems: string[] = [];

  for (const relativePath of requiredPaths()) {
    const absolutePath = resolve(ROOT, relativePath);
    const file = Bun.file(absolutePath);

    if (!(await file.exists())) {
      problems.push(`missing: ${relativePath} (electron-builder.config.ts references it)`);
      continue;
    }

    if (file.size === 0) {
      problems.push(`empty: ${relativePath}`);
      continue;
    }

    // codesign reads the entitlements file itself, so a truncated or
    // non-plist file fails at signing time with the same opaque
    // "cannot read entitlement data" as a missing one.
    if (relativePath.endsWith(".plist") && !isPlistShaped(await file.text())) {
      problems.push(`not a plist: ${relativePath}`);
    }
  }

  return problems;
};

if (import.meta.main) {
  const problems = await checkBuildResources();

  if (problems.length > 0) {
    console.error("[check-build-resources] FAIL — apps/desktop/build/ is incomplete:");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      "\nThese files are committed static build inputs. Restore them from the last" +
        "\ngood tag, e.g. `git checkout <tag> -- apps/desktop/build/`.",
    );
    process.exit(1);
  }

  console.log(`[check-build-resources] OK — ${requiredPaths().join(", ")}`);
}
