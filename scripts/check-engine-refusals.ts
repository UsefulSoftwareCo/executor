/**
 * Every refusal of a past time the patched workflow engine can throw is classed `past`.
 *
 * The local engine in `@alchemy.run/cloudflare-runtime` refuses a `sleepUntil` whose time has passed
 * by throwing an `Error`, and `engineErrorCode` (`packages/sdk/src/contracts/workflow-errors.ts`)
 * reads that message to class it `past`, which ends the sleep instead of failing the run
 * (`sleep-until.ts`). Our patch to that package once reworded the refusal, and the classifier did not
 * know the new words, so such a run failed under load. This reads the patch, finds each refusal by
 * its condition (`timestamp < now`, then a thrown `Error`), not by its words, in the code the patch
 * leaves (its added and context lines), and fails naming any message the classifier does not class
 * `past`. It also fails when it finds none, since then the patch no longer looks as this expects.
 */
import { readFileSync } from "node:fs";
import { engineErrorCode } from "../packages/sdk/src/contracts/workflow-errors.ts";

const dependency = "@alchemy.run/cloudflare-runtime";
const { patchedDependencies = {} } = JSON.parse(readFileSync("package.json", "utf8")) as {
  readonly patchedDependencies?: Readonly<Record<string, string>>;
};
const patches = Object.entries(patchedDependencies)
  .filter(([selector]) => selector.startsWith(`${dependency}@`))
  .map(([, path]) => path);
if (patches.length === 0) {
  console.error(`check-engine-refusals: no patch for ${dependency} in package.json.`);
  process.exit(1);
}

/** A refusal: `timestamp < now`, then `throw Error(...)` or `throw new Error(...)` with one literal. */
const refusal =
  /timestamp\s*<\s*now\s*\)\s*\{?\s*throw\s+(?:new\s+)?Error\(\s*(["\x27`])((?:\\.|(?!\1)[^\\])*)\1/gu;

const failures: Array<string> = [];
let found = 0;
for (const path of patches) {
  // The code the patch leaves: its added and context lines, without the diff markers. The bundled
  // worker holds its code as JSON strings, whose quotes are escaped once more.
  const left = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("+++") && (line.startsWith("+") || line.startsWith(" ")))
    .map((line) => line.slice(1))
    .join("\n")
    .replaceAll('\\"', '"');
  for (const match of left.matchAll(refusal)) {
    found += 1;
    const message = match[2]!;
    const code = engineErrorCode(new Error(message));
    if (code !== "past")
      failures.push(
        `${path}: the engine refuses a past time with "${message}", classed "${code}".`,
      );
  }
}
if (found === 0) {
  console.error(
    `check-engine-refusals: found no refusal of a past time (timestamp < now, then a thrown Error) in ${patches.join(", ")}. Update this check to read the engine as the patch now leaves it.`,
  );
  process.exit(1);
}
if (failures.length > 0) {
  console.error(
    [
      ...failures,
      "Add the wording to pastSleep in packages/sdk/src/contracts/workflow-errors.ts, with where it comes from.",
    ].join("\n"),
  );
  process.exit(1);
}
console.log(`check-engine-refusals: ${found} refusals of a past time, all classed past.`);
