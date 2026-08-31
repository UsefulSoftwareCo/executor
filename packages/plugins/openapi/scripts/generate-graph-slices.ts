/**
 * Generate the Microsoft Graph slice release assets.
 *
 *   bun scripts/generate-graph-slices.ts [--source <path-or-url>] [--out <dir>]
 *
 * Fetches (or reads) the Graph OpenAPI monolith, builds one slice per catalog
 * preset plus the default bundle via `slice-build.ts`, validates every slice
 * against the runtime's streamable profile, and writes `<asset>.yaml` files
 * plus `manifest.json` to the output directory. The graph-slices workflow runs
 * this and uploads the output to the `graph-slices` release tag; runtime
 * resolution lives in `src/providers/microsoft/slices.ts`.
 *
 * Offline-only: this whole-parses the 43MB source, which only works where
 * memory is free (CI runner / dev machine), never in a Workers isolate.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { structuralSplit } from "../src/sdk/split";
import {
  MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
  MICROSOFT_GRAPH_OPENAPI_URL,
  microsoftGraphScopePresets,
} from "../src/providers/microsoft/presets";
import { MICROSOFT_GRAPH_DEFAULT_SLICE_ASSET } from "../src/providers/microsoft/slices";
import {
  buildGraphSliceDocument,
  parseGraphSourceDocument,
} from "../src/providers/microsoft/slice-build";

const argValue = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
};

const source = argValue("--source") ?? MICROSOFT_GRAPH_OPENAPI_URL;
const outDir = argValue("--out") ?? "graph-slices-out";

const readSource = async (): Promise<string> => {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Failed to fetch Graph source: HTTP ${response.status}`);
    }
    return response.text();
  }
  return readFile(source, "utf8");
};

const sourceText = await readSource();
const sourceSha256 = createHash("sha256").update(sourceText).digest("hex");
const doc = parseGraphSourceDocument(sourceText);
if (!doc) {
  throw new Error("Microsoft Graph source did not parse to an object");
}

const selections: readonly { readonly asset: string; readonly presetIds: readonly string[] }[] = [
  ...microsoftGraphScopePresets.map((preset) => ({ asset: preset.id, presetIds: [preset.id] })),
  {
    asset: MICROSOFT_GRAPH_DEFAULT_SLICE_ASSET,
    presetIds: MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
  },
];

await mkdir(outDir, { recursive: true });

const manifestAssets: Record<
  string,
  {
    readonly bytes: number;
    readonly paths: number;
    readonly operations: number;
    readonly schemas: number;
  }
> = {};

for (const { asset, presetIds } of selections) {
  const slice = buildGraphSliceDocument(doc, presetIds);
  if (slice.operationCount === 0) {
    throw new Error(`Slice "${asset}" kept zero operations — preset filter or source drifted`);
  }
  const structure = structuralSplit(slice.specText);
  if (!structure) {
    throw new Error(`Slice "${asset}" is not in the streamable block-YAML profile`);
  }
  if (structure.pathItems.length !== slice.pathCount) {
    throw new Error(
      `Slice "${asset}" splitter sees ${structure.pathItems.length} path-items, expected ${slice.pathCount}`,
    );
  }
  await writeFile(join(outDir, `${asset}.yaml`), slice.specText);
  manifestAssets[asset] = {
    bytes: Buffer.byteLength(slice.specText),
    paths: slice.pathCount,
    operations: slice.operationCount,
    schemas: slice.schemaCount,
  };
  console.log(
    `${asset}: ${(Buffer.byteLength(slice.specText) / 1024 / 1024).toFixed(2)}MB, ` +
      `${slice.pathCount} paths, ${slice.operationCount} operations, ${slice.schemaCount} schemas`,
  );
}

await writeFile(
  join(outDir, "manifest.json"),
  `${JSON.stringify({ source, sourceSha256, generatedAt: new Date().toISOString(), assets: manifestAssets }, null, 2)}\n`,
);
console.log(`wrote ${selections.length} slices + manifest.json to ${outDir}`);
