import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

const require = createRequire(import.meta.url);

function resolveEvePackageRoot() {
  let current = dirname(require.resolve("eve"));

  while (basename(current) !== "eve") {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Could not resolve eve package root.");
    }
    current = parent;
  }

  return current;
}

const packageRoot = resolveEvePackageRoot();
const routeOutputPath = join(
  packageRoot,
  "dist/src/internal/workflow-bundle/eve-service-route-output.js",
);
const buildApplicationPath = join(
  packageRoot,
  "dist/src/internal/nitro/host/build-application.js",
);
const routeOutputSource = readFileSync(routeOutputPath, "utf8");
const buildApplicationSource = readFileSync(buildApplicationPath, "utf8");
const expectedPrefix =
  "EVE_VERCEL_FUNCTION_PREFIXES=[`__server.func`,`eve/`,`.well-known/workflow/`]";
const expectedNormalization =
  "normalized Eve Vercel function output for Vercel service packaging";

if (!existsSync(routeOutputPath) || !routeOutputSource.includes(expectedPrefix)) {
  throw new Error(
    `Expected patched eve Vercel output normalizer at ${routeOutputPath}.`,
  );
}

if (
  !existsSync(buildApplicationPath) ||
  !buildApplicationSource.includes(expectedNormalization)
) {
  throw new Error(
    `Expected patched eve Vercel build output normalization at ${buildApplicationPath}.`,
  );
}

console.log(
  `[open-agents] verified patched eve Vercel output: ${routeOutputPath}, ${buildApplicationPath}`,
);
