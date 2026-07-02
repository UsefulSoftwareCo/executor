// Find (and optionally kill) leaked dev-stack processes — vite dev servers,
// PGlite dev-dbs, e2e emulators — left behind when a session dies without
// running its teardown. Default: kill only ORPHANS (processes whose checkout
// path no longer exists, e.g. a removed worktree) and list the rest.
// `--all` also kills live-checkout servers (do this only when you know no
// other agent session is using them). `--dry-run` lists without killing.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const killAll = args.has("--all");

const DEV_PATTERN = /vite dev|dev-db\.ts|scripts\/dev\.ts/;

const ps = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });

interface Candidate {
  readonly pid: number;
  readonly command: string;
  readonly checkout: string | undefined;
  readonly orphan: boolean;
}

const candidates: Candidate[] = [];
for (const line of ps.split("\n")) {
  const match = line.match(/^\s*(\d+)\s+(.*)$/);
  if (!match) continue;
  const [, pidText, command] = match;
  if (!DEV_PATTERN.test(command!)) continue;
  if (Number(pidText) === process.pid) continue;
  // The checkout root is whatever absolute path prefixes node_modules/ or a
  // workspace dir in the command line.
  const pathMatch = command!.match(/(\/[^ ]*?)\/(?:node_modules|apps|packages|e2e)\//);
  const checkout = pathMatch?.[1];
  const orphan = checkout !== undefined && !existsSync(checkout);
  candidates.push({ pid: Number(pidText), command: command!.slice(0, 160), checkout, orphan });
}

if (candidates.length === 0) {
  console.log("reap: no dev-stack processes found.");
  process.exit(0);
}

for (const c of candidates) {
  const shouldKill = !dryRun && (c.orphan || killAll);
  const tag = c.orphan ? "ORPHAN" : "live  ";
  console.log(`${shouldKill ? "KILL " : "keep "} ${tag} pid=${c.pid} ${c.command}`);
  if (shouldKill) {
    try {
      // Group kill (detached boots) with a direct-pid fallback.
      try {
        process.kill(-c.pid, "SIGTERM");
      } catch {
        process.kill(c.pid, "SIGTERM");
      }
    } catch (error) {
      console.error(`  failed to kill ${c.pid}: ${String(error)}`);
    }
  }
}

if (!killAll && candidates.some((c) => !c.orphan)) {
  console.log(
    "\nLive-checkout servers were kept (another session may own them); --all kills those too.",
  );
}
