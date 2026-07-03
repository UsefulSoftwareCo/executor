import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EVE_FUNCTION_CONFIGS = [
  join(".vercel", "output", "functions", "__server.func", ".vc-config.json"),
  join(".vercel", "output", "functions", "eve", "__server.func", ".vc-config.json"),
];

const EVE_FUNCTION_MAX_DURATION_SECONDS = 300;

function patchFunctionConfig(path: string) {
  if (!existsSync(path)) {
    return false;
  }

  const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(
    path,
    `${JSON.stringify({ ...config, maxDuration: EVE_FUNCTION_MAX_DURATION_SECONDS }, null, 2)}\n`,
  );
  return true;
}

const patched = EVE_FUNCTION_CONFIGS.filter(patchFunctionConfig);

if (patched.length === 0) {
  throw new Error("No Eve Vercel function configs were found to patch.");
}

console.log(
  `[open-agents] patched Eve Vercel function maxDuration=${EVE_FUNCTION_MAX_DURATION_SECONDS}s: ${patched.join(", ")}`,
);
