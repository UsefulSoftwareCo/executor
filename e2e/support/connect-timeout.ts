/**
 * How long the e2e harness's own outbound connections give each address of a name before trying the
 * next: Node's network family auto-selection attempt time-out, 250 ms by default on Node 24.22.1
 * (`net.getDefaultAutoSelectFamilyAttemptTimeout()`). With a name's two IPv4 addresses slow to
 * answer and its IPv6 addresses failing at once (a runner without an IPv6 route), Node gives up
 * after about 500 ms: the `AggregateError ETIMEDOUT, after 507 ms` of emulator calls on 16 Nov,
 * each of which spent one of the call's three attempts. At 2,500 ms that case gives up after about
 * 5 s, inside each attempt's own 10 s (support/emulators.ts), and a connect that answers is not
 * slowed at all.
 *
 * The test client only: product processes the harness starts are other processes and keep Node's
 * default. Imported first by each entry point that makes outbound calls (run.ts, deployed.ts,
 * cleanup-deployed.ts, cli.ts, create-emulators.ts) and by Vitest's setup file (setup.ts), so every
 * worker has it too.
 */
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

export const connectAttemptMs = 2_500;

setDefaultAutoSelectFamilyAttemptTimeout(connectAttemptMs);
