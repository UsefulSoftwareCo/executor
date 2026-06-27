import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { evidenceSummaryMarkdown, summaryRunsFromManifest } from "../src/evidence-publication";

const argumentValue = (name: string) => {
  const args = process.argv.slice(2);
  const equals = args.find((argument) => argument.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const manifestPath = argumentValue("--manifest");
const viewerUrl = argumentValue("--viewer-url");

if (!manifestPath || !viewerUrl) {
  console.error(
    "usage: bun e2e/scripts/evidence-publication-summary.ts --manifest <path> --viewer-url <url>",
  );
  process.exitCode = 1;
} else {
  try {
    const manifest: unknown = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
    process.stdout.write(evidenceSummaryMarkdown(viewerUrl, summaryRunsFromManifest(manifest)));
  } catch (error) {
    console.error(`evidence-publication-summary: ${String(error)}`);
    process.exitCode = 1;
  }
}
