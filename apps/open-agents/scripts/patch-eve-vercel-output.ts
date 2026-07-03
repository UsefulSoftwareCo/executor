import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type VercelOutputRoute = {
  src?: string;
  [key: string]: unknown;
};

type VercelOutputConfig = {
  routes?: VercelOutputRoute[];
  [key: string]: unknown;
};

const EVE_FUNCTION_CONFIGS = [
  join(".vercel", "output", "functions", "__server.func", ".vc-config.json"),
  join(".vercel", "output", "functions", "eve", "__server.func", ".vc-config.json"),
];

const EVE_OUTPUT_CONFIG = join(".vercel", "output", "config.json");
const EVE_FUNCTION_MAX_DURATION_SECONDS = 300;
const VERCEL_NAMED_CAPTURE_GROUP = /\(\?<[^>]+>/g;

export function normalizeVercelRouteSource(source: string): string {
  const normalizedSource = source.replace(VERCEL_NAMED_CAPTURE_GROUP, "(");

  if (!normalizedSource.startsWith("/") || !normalizedSource.includes("(")) {
    return normalizedSource;
  }

  return `^${normalizedSource}$`;
}

export function normalizeVercelOutputRoutes(config: VercelOutputConfig): {
  config: VercelOutputConfig;
  normalizedRouteCount: number;
} {
  let normalizedRouteCount = 0;
  const routes = config.routes?.map((route) => {
    if (!route.src) {
      return route;
    }

    const src = normalizeVercelRouteSource(route.src);
    if (src === route.src) {
      return route;
    }

    normalizedRouteCount += 1;
    return { ...route, src };
  });

  return {
    config: routes ? { ...config, routes } : config,
    normalizedRouteCount,
  };
}

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

function patchOutputConfig(path: string): number {
  if (!existsSync(path)) {
    throw new Error(`Expected Eve Vercel output config at ${path}.`);
  }

  const config = JSON.parse(readFileSync(path, "utf8")) as VercelOutputConfig;
  const result = normalizeVercelOutputRoutes(config);
  writeFileSync(path, `${JSON.stringify(result.config, null, 2)}\n`);
  return result.normalizedRouteCount;
}

export function patchEveVercelOutput(): void {
  const patched = EVE_FUNCTION_CONFIGS.filter(patchFunctionConfig);

  if (patched.length === 0) {
    throw new Error("No Eve Vercel function configs were found to patch.");
  }

  const normalizedRouteCount = patchOutputConfig(EVE_OUTPUT_CONFIG);

  console.log(
    `[open-agents] patched Eve Vercel function maxDuration=${EVE_FUNCTION_MAX_DURATION_SECONDS}s: ${patched.join(", ")}`,
  );
  console.log(
    `[open-agents] normalized ${normalizedRouteCount} Eve Vercel route source${normalizedRouteCount === 1 ? "" : "s"}.`,
  );
}

if (import.meta.main) {
  patchEveVercelOutput();
}
