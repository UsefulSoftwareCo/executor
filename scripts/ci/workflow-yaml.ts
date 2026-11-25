import { readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: node scripts/ci/workflow-yaml.ts FILE...");
  process.exit(2);
}
const problems: Array<string> = [];
const workflows: Record<string, unknown> = {};
for (const file of files) {
  const parsed = parseAllDocuments(readFileSync(file, "utf8"), { uniqueKeys: true });
  const documents = Array.isArray(parsed) ? parsed : [];
  if (!Array.isArray(parsed) || documents.length !== 1) {
    problems.push(`${file}: holds ${documents.length} YAML documents, not one`);
    continue;
  }
  const [document] = documents;
  for (const problem of [...document!.errors, ...document!.warnings])
    problems.push(`${file}: ${problem.message.split("\n")[0]}`);
  workflows[file] = document!.toJS({ maxAliasCount: 100 });
}
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(JSON.stringify(workflows));
