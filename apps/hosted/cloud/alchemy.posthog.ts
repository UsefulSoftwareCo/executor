/** Persistent analytics resources. Deploy before the hosted application in the same stage. */
import * as Alchemy from "alchemy";
import { Random, RandomProvider } from "alchemy/Random";
import * as Output from "alchemy/Output";
import { retain } from "alchemy/RemovalPolicy";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Layer, Option, Redacted } from "effect";
import {
  PostHogProject,
  postHogProjectProvider,
  postHogProviderCredentials,
} from "./src/infrastructure/posthog-provider.ts";
import {
  PostHogDashboard,
  PostHogInsight,
  postHogReportProviders,
} from "./src/infrastructure/posthog-reports.ts";
import { retiredExperimentProvider } from "./src/infrastructure/posthog-experiment.ts";
import { stackState } from "./src/infrastructure/state.ts";
import { usageReports } from "./src/infrastructure/usage-reports.ts";
import { cloudHosts } from "./src/infrastructure/stage.ts";

export default Alchemy.Stack(
  "executor-next-posthog",
  {
    providers: postHogProviderCredentials(
      Layer.mergeAll(
        postHogProjectProvider(),
        postHogReportProviders(),
        retiredExperimentProvider(),
        RandomProvider(),
      ),
    ),
    state: stackState,
  },
  Effect.gen(function* () {
    const stage = yield* Stage;
    const organizationId = yield* Config.NonEmptyString("POSTHOG_ORGANIZATION_ID");
    const uiHost = yield* Config.NonEmptyString("POSTHOG_HOST");
    const apiHost = yield* Config.NonEmptyString("POSTHOG_INGEST_HOST");
    const proxy = yield* Random("BrowserProxyPath", { bytes: 8 }).pipe(retain());
    const project = yield* PostHogProject("Project", {
      organizationId,
      name: stage === "v2" ? "Executor V2" : `Executor V2 (${stage})`,
      // Pages run on the browser origin and, for marketing, on the edge.
      appUrls: yield* cloudHosts.pipe(
        Effect.orDie,
        Effect.map((hosts) => [
          ...new Set([
            hosts.browser,
            hosts.deployment,
            ...Option.toArray(Option.map(hosts.roles, (roles) => roles.edge)),
          ]),
        ]),
      ),
      timezone: "America/Los_Angeles",
    }).pipe(retain());
    const dashboard = yield* PostHogDashboard("Usage", {
      projectId: project.id,
      name: "Executor V2 usage",
      description:
        "Acquisition, activation, feature use, failures and return use. Internal and synthetic activity are excluded by default.",
    }).pipe(retain());
    for (const report of usageReports) {
      yield* PostHogInsight(report.id, {
        projectId: project.id,
        dashboardId: dashboard.id,
        ...report,
      }).pipe(retain());
    }
    return {
      proxyPath: proxy.text.pipe(Output.map((value) => `/api/${Redacted.value(value)}`)),
      dashboardId: dashboard.id,
      projectId: project.id,
      apiToken: project.apiToken,
      uiHost,
      apiHost,
    };
  }),
);
