/**
 * Fails when a test exists outside `e2e/`. Executor is tested end to end only;
 * see notes/coding-style.md.
 */
import { execFileSync } from "node:child_process";

const test = /(^|\/)(__tests__\/|test\/|[^/]+\.(test|spec|test-d)\.[cm]?[jt]sx?$)/;

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\n")
  .filter((file) => test.test(file) && !file.startsWith("e2e/"));

if (files.length) {
  console.error("Tests belong only in e2e/. Write an E2E scenario instead (see e2e/README.md):");
  for (const file of files) console.error(`  ${file}`);
  process.exit(1);
}
console.log("No tests outside e2e/.");
