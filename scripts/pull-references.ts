import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

const REFERENCE_DIR = join(import.meta.dirname, "../.reference");

const repos = [
  { name: "effect", url: "https://github.com/Effect-TS/effect.git" },
  { name: "effect-atom", url: "https://github.com/tim-smart/effect-atom.git" },
  { name: "executor", url: "https://github.com/UsefulSoftwareCo/executor.git" },
  {
    name: "tanstack-router",
    url: "https://github.com/TanStack/router.git",
  },
];

await mkdir(REFERENCE_DIR, { recursive: true });

for (const repo of repos) {
  const dest = join(REFERENCE_DIR, repo.name);
  if (existsSync(dest)) {
    console.log(`Pulling ${repo.name}...`);
    await $`git -C ${dest} pull --ff-only`.quiet();
  } else {
    console.log(`Cloning ${repo.name}...`);
    await $`git clone --depth 1 ${repo.url} ${dest}`.quiet();
  }
  console.log(`  ✓ ${repo.name}`);
}
