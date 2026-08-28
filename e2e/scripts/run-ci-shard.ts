import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseCiShardRequest, planTargetShards } from "./ci-shard";

const request = parseCiShardRequest(process.argv.slice(2));
if (!request.ok) {
  console.error(request.error.message);
  process.exit(2);
}

const e2eRoot = fileURLToPath(new URL("..", import.meta.url));
const plan = await planTargetShards(request.value.target, e2eRoot);
const assignment = plan[request.value.index - 1];
if (assignment === undefined || assignment.files.length === 0) {
  throw new Error("configured shard has no test files");
}

console.log(
  `Running ${request.value.target} shard ${request.value.index}/${request.value.count}: ` +
    `${assignment.files.length} files, estimated ${Math.round(assignment.estimatedDurationMs / 1000)}s`,
);
for (const file of assignment.files) console.log(`  ${file}`);

const child = spawnSync(
  process.execPath,
  ["x", "vitest", "run", "--project", request.value.target, ...assignment.files],
  {
    cwd: e2eRoot,
    env: process.env,
    stdio: "inherit",
  },
);
if (child.error !== undefined) throw child.error;
if (child.signal !== null) {
  throw new Error(`Vitest shard terminated by signal ${child.signal}`);
}
process.exit(child.status ?? 1);
