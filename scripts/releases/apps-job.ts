import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { waitForJob } from "./job-wait.ts";

const jobName = "apps";

const minutes = 15;

NodeRuntime.runMain(
  waitForJob({
    job: jobName,
    minutes,
    ended: (conclusion, url) =>
      `The ${jobName} job ended ${conclusion}, so npm may not serve this build's apps release; not deploying.${url === undefined ? "" : ` ${url}`}`,
    late: (reason, limit) =>
      `The ${jobName} job did not finish within ${limit} (${reason}); not deploying. Rerun this job once it has.`,
    succeeded: `The ${jobName} job succeeded: it published this build's apps release or found it on npm unchanged.`,
  }).pipe(Effect.provide([FetchHttpClient.layer, NodeServices.layer])),
);
