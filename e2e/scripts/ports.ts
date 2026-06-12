// Print this checkout's derived e2e ports (see src/ports.ts) so an agent or
// human can curl the booted servers or attach with E2E_<TARGET>_URL.
import { AUTUMN_EMULATOR_PORT, CLOUD_DB_PORT, CLOUD_PORT, WORKOS_EMULATOR_PORT } from "../targets/cloud";
import { SELFHOST_PORT } from "../targets/selfhost";
import { repoRoot } from "../src/ports";

console.log(`e2e ports for ${repoRoot}`);
console.log(`  cloud           http://127.0.0.1:${CLOUD_PORT}`);
console.log(`  cloud dev-db    ${CLOUD_DB_PORT}`);
console.log(`  workos emulator ${WORKOS_EMULATOR_PORT}`);
console.log(`  autumn emulator ${AUTUMN_EMULATOR_PORT}`);
console.log(`  selfhost        http://localhost:${SELFHOST_PORT}`);
