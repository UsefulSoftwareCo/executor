/** Persistent analytics resources. Deploy before the hosted application in the same stage. */
import * as Alchemy from "alchemy";
import { Random, RandomProvider } from "alchemy/Random";
import * as Output from "alchemy/Output";
import { retain } from "alchemy/RemovalPolicy";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Layer, Redacted } from "effect";
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
import {
  heroExperimentDefinition,
  PostHogHeroExperiment,
  postHogExperimentProvider,
} from "./src/infrastructure/posthog-experiment.ts";
import { stackState } from "./src/infrastructure/state.ts";
import { cloudOrigin } from "./src/infrastructure/stage.ts";

export default Alchemy.Stack(
  "executor-next-posthog",
  {
    providers: postHogProviderCredentials(
      Layer.mergeAll(
        postHogProjectProvider(),
        postHogReportProviders(),
        postHogExperimentProvider(),
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
      appUrls: [yield* cloudOrigin.pipe(Effect.orDie)],
      timezone: "America/Los_Angeles",
    }).pipe(retain());
    const dashboard = yield* PostHogDashboard("Usage", {
      projectId: project.id,
      name: "Executor V2 usage",
      description: "Acquisition and product activity. Synthetic traffic is excluded.",
    }).pipe(retain());
    for (const [id, name, event] of [
      ["Visitors", "Daily visitors", "$pageview"],
      ["Executions", "Tool executions", "tool_execution_completed"],
      ["Connections", "Accounts connected", "account_connected"],
    ] as const) {
      yield* PostHogInsight(id, {
        projectId: project.id,
        dashboardId: dashboard.id,
        name,
        description: `Executor V2 ${name.toLowerCase()}.`,
        query: {
          kind: "InsightVizNode",
          source: {
            kind: "TrendsQuery",
            version: 4,
            dateRange: { date_from: "-30d" },
            interval: "day",
            filterTestAccounts: true,
            series: [{ kind: "EventsNode", event, math: id === "Visitors" ? "dau" : "total" }],
          },
        },
      }).pipe(retain());
    }
    const hero = yield* PostHogHeroExperiment("HeroExperiment", {
      projectId: project.id,
      definition: heroExperimentDefinition,
    }).pipe(retain());
    return {
      proxyPath: proxy.text.pipe(Output.map((value) => `/api/${Redacted.value(value)}`)),
      dashboardId: dashboard.id,
      heroExperimentId: hero.id,
      projectId: project.id,
      apiToken: project.apiToken,
      uiHost,
      apiHost,
    };
  }),
);
