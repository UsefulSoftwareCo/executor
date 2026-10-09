/**
 * Better Auth's per-address limit throttles Cloud sign-in and OAuth client registration. Only
 * automated environments may turn it off (`cloudAuthRateLimit`). This check evaluates the rule for
 * every combination of stage, origin, `TEST_STAGE_AUTH_RATE_LIMIT` and runtime, with the stage
 * given as Alchemy's `Stage` service (as a deploy reads it) and as `ALCHEMY_STAGE` (as a deployed
 * Worker reads it). It fails when:
 *
 * - production (`v2`) runs without the limit in any combination;
 * - a deployed Worker runs without it on any stage but `test-e2e-*`;
 * - `alchemy dev` runs without it on an origin that is not loopback;
 * - the switches the local e2e runner and deployed e2e stages use stop working.
 */
import { Stage } from "alchemy/Stage";
import { ConfigProvider, Effect } from "effect";
import { cloudAuthRateLimit, productionStage } from "../src/infrastructure/stage.ts";

const stages = [
  productionStage,
  "development",
  "staging",
  "dev",
  "dev-checkout",
  "e2e-0123456789abcdef",
  "test-e2e-check",
  "test-preview",
  "test-pr-1",
];
const loopbackOrigins = ["http://localhost:4411", "http://127.0.0.1:4411", "http://[::1]:4411"];
const origins = [...loopbackOrigins, "https://executor.sh", "https://cloud.example.com"];
const switches = [undefined, "true", "false"] as const;

interface Case {
  readonly stage: string;
  readonly stageSource: "Stage service" | "ALCHEMY_STAGE";
  readonly origin: string;
  readonly configured: (typeof switches)[number];
  readonly localRuntime: boolean;
}

const describe = (c: Case) =>
  `${c.localRuntime ? "alchemy dev" : "deployed Worker"}, stage ${c.stage} (${c.stageSource}), ` +
  `BETTER_AUTH_URL=${c.origin}, TEST_STAGE_AUTH_RATE_LIMIT=${c.configured ?? "<unset>"}`;

const evaluate = (c: Case) => {
  const env: Record<string, string> = {
    BETTER_AUTH_URL: c.origin,
    ...(c.stageSource === "ALCHEMY_STAGE" ? { ALCHEMY_STAGE: c.stage } : {}),
    ...(c.configured === undefined ? {} : { TEST_STAGE_AUTH_RATE_LIMIT: c.configured }),
  };
  const rule = cloudAuthRateLimit(c.localRuntime).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
  );
  return Effect.runSync(
    c.stageSource === "Stage service" ? rule.pipe(Effect.provideService(Stage, c.stage)) : rule,
  );
};

const cases = stages.flatMap((stage) =>
  (["Stage service", "ALCHEMY_STAGE"] as const).flatMap((stageSource) =>
    origins.flatMap((origin) =>
      switches.flatMap((configured) =>
        [false, true].map((localRuntime): Case => ({
          stage,
          stageSource,
          origin,
          configured,
          localRuntime,
        })),
      ),
    ),
  ),
);

const failures: string[] = [];
let off = 0;
for (const c of cases) {
  const enabled = evaluate(c);
  if (enabled) continue;
  off++;
  if (c.stage === productionStage)
    failures.push(`Production runs without the limit: ${describe(c)}`);
  else if (!c.localRuntime && !c.stage.startsWith("test-e2e-"))
    failures.push(`A deployed Worker runs without the limit: ${describe(c)}`);
  else if (c.localRuntime && !c.stage.startsWith("test-") && !loopbackOrigins.includes(c.origin))
    failures.push(`Cloud dev runs without the limit off loopback: ${describe(c)}`);
}

// The off switches must keep working, or the rules above would pass with the limit always on.
const expected: ReadonlyArray<readonly [Case, boolean]> = [
  [
    {
      stage: "e2e-0123456789abcdef",
      stageSource: "ALCHEMY_STAGE",
      origin: "http://localhost:4411",
      configured: "false",
      localRuntime: true,
    },
    false,
  ],
  [
    {
      stage: "e2e-0123456789abcdef",
      stageSource: "ALCHEMY_STAGE",
      origin: "http://localhost:4411",
      configured: undefined,
      localRuntime: true,
    },
    true,
  ],
  [
    {
      stage: "test-e2e-check",
      stageSource: "ALCHEMY_STAGE",
      origin: "https://cloud.example.com",
      configured: undefined,
      localRuntime: false,
    },
    false,
  ],
  [
    {
      stage: "test-e2e-check",
      stageSource: "ALCHEMY_STAGE",
      origin: "https://cloud.example.com",
      configured: "true",
      localRuntime: false,
    },
    true,
  ],
];
for (const [c, enabled] of expected)
  if (evaluate(c) !== enabled)
    failures.push(`Expected the limit ${enabled ? "on" : "off"}: ${describe(c)}`);

if (failures.length) {
  console.error("Cloud auth rate limit rules failed:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(
  `Cloud auth rate limit: ${cases.length} combinations, off in ${off}, ` +
    "never off in production or a deployed non-e2e stage.",
);
