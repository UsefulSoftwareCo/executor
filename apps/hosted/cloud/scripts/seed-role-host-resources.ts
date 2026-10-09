/**
 * One-off, additive seed of the role hosts' OAuth resources for connections created before the
 * role hosts were added (`notes/cloud-domains.md`; see `notes/cloud-role-hosts.md`). Run it with
 * the deployment's own migration settings (`DATABASE_URL`, `BETTER_AUTH_SECRET` and the sign-in
 * clients; `BETTER_AUTH_URL` except on a test stage) and its stage, which names the role hosts:
 *
 *   ALCHEMY_STAGE=<stage> node apps/hosted/cloud/scripts/seed-role-host-resources.ts          # report only
 *   ALCHEMY_STAGE=<stage> node apps/hosted/cloud/scripts/seed-role-host-resources.ts --apply  # insert
 *
 * A stage other than `v2` or `test-<slug>` names its role hosts with `EXECUTOR_ROLE_HOSTS_DOMAIN`.
 * It refuses to run for a deployment without role hosts. Safe to re-run; it prints counts only.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Console, Effect } from "effect";
import { parseArgs } from "node:util";
import { seedRoleHostResources } from "../src/implementation/role-host-resources.ts";

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });

NodeRuntime.runMain(
  seedRoleHostResources(values.apply ? "apply" : "report").pipe(
    Effect.flatMap((summary) => Console.log(JSON.stringify(summary))),
  ),
);
