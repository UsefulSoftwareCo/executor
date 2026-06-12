// Print this checkout's PREFERRED e2e ports (see src/ports.ts). These are
// where a suite normally boots; if the block is locked or squatted at boot
// time, claimPorts walks to the next free block and the suite logs the move.
// When attaching mid-run, the booted vite's actual port is authoritative —
// check the suite's log line or `ps | grep 'vite dev'`.
import {
  AUTUMN_EMULATOR_PORT,
  CLOUD_DB_PORT,
  CLOUD_PORT,
  WORKOS_EMULATOR_PORT,
} from "../targets/cloud";
import { SELFHOST_PORT } from "../targets/selfhost";
import { repoRoot } from "../src/ports";

console.log(`preferred e2e ports for ${repoRoot}`);
console.log(`  cloud           http://127.0.0.1:${CLOUD_PORT}`);
console.log(`  cloud dev-db    ${CLOUD_DB_PORT}`);
console.log(`  workos emulator ${WORKOS_EMULATOR_PORT}`);
console.log(`  autumn emulator ${AUTUMN_EMULATOR_PORT}`);
console.log(`  selfhost        http://localhost:${SELFHOST_PORT}`);
