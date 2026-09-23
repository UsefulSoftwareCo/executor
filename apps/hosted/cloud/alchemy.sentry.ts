/** Persistent error-monitoring projects. The app consumes public DSNs from this stack. */
import * as Alchemy from "alchemy";
import { Random, RandomProvider } from "alchemy/Random";
import * as Output from "alchemy/Output";
import { retain } from "alchemy/RemovalPolicy";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Layer, Redacted } from "effect";
import {
  SentryProject,
  SentryClientKey,
  sentryProviderCredentials,
  sentryProjectProvider,
  sentryClientKeyProvider,
} from "./src/infrastructure/sentry-provider.ts";
import { SentryErrorAlert, sentryErrorAlertProvider } from "./src/infrastructure/sentry-alert.ts";
import { stackState } from "./src/infrastructure/state.ts";

export default Alchemy.Stack(
  "executor-next-sentry",
  {
    providers: sentryProviderCredentials(
      Layer.mergeAll(
        sentryProjectProvider(),
        sentryClientKeyProvider(),
        sentryErrorAlertProvider(),
        RandomProvider(),
      ),
    ),
    state: stackState,
  },
  Effect.gen(function* () {
    const stage = yield* Stage;
    const organization = yield* Config.NonEmptyString("SENTRY_ORG");
    const team = yield* Config.NonEmptyString("SENTRY_TEAM");
    const tunnel = yield* Random("BrowserTunnelPath", { bytes: 8 }).pipe(retain());
    const browser = yield* SentryProject("Browser", {
      organization,
      team,
      slug: `executor-${stage}-web`,
      name: `Executor ${stage === "v2" ? "V2" : stage} Web`,
      platform: "javascript-react",
    }).pipe(retain());
    const cloud = yield* SentryProject("Cloud", {
      organization,
      team,
      slug: `executor-${stage}-cloud`,
      name: `Executor ${stage === "v2" ? "V2" : stage} Cloud`,
      platform: "node-cloudflare-workers",
    }).pipe(retain());
    const browserKey = yield* SentryClientKey("BrowserKey", {
      organization,
      project: browser.slug,
      name: `alchemy:executor-next-sentry:${stage}:browser`,
    }).pipe(retain());
    const cloudKey = yield* SentryClientKey("CloudKey", {
      organization,
      project: cloud.slug,
      name: `alchemy:executor-next-sentry:${stage}:cloud`,
    }).pipe(retain());
    yield* SentryErrorAlert("Errors", {
      organization,
      team,
      projects: [
        { id: browser.id, dsn: browserKey.dsn },
        { id: cloud.id, dsn: cloudKey.dsn },
      ],
      name: `Executor ${stage === "v2" ? "V2" : stage} errors`,
      environment: stage,
      enabled: stage === "v2",
    });
    return {
      organization,
      browserProject: browser.slug,
      cloudProject: cloud.slug,
      browserTunnel: tunnel.text.pipe(
        Output.map((value) => `/api/${Redacted.value(value)}/submit`),
      ),
      browserDsn: browserKey.dsn,
      cloudDsn: cloudKey.dsn,
    };
  }),
);
