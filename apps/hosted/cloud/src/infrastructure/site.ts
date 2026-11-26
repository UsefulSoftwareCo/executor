import * as Command from "alchemy/Command";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Stage } from "alchemy/Stage";
import { Effect, Option } from "effect";
import { chatGptSettings } from "../implementation/chatgpt-sign-in.ts";
import { postHogBindings } from "./posthog.ts";
import { cloudReleaseNotesInput } from "./release-notes.ts";
import { sentryBindings } from "./sentry.ts";
import { cloudHosts } from "./stage.ts";

export const cloudSite = Effect.gen(function* () {
  const analytics = yield* postHogBindings;
  const sentry = yield* sentryBindings;
  const environment = (yield* AlchemyContext).dev ? {} : { EXECUTOR_ENVIRONMENT: yield* Stage };
  const hosts = yield* cloudHosts.pipe(Effect.orDie);
  const notes = yield* cloudReleaseNotesInput.pipe(Effect.orDie);
  return yield* Command.Build("Site", {
    cwd: "../../..",
    command: "bun run hosted:cloud:site:build",
    outdir: "apps/hosted/cloud/.generated/site",
    env: {
      ...analytics.build,
      ...sentry.build,
      ...environment,
      EXECUTOR_SITE_ORIGIN: Option.match(hosts.roles, {
        onNone: () => hosts.deployment,
        onSome: (roles) => roles.edge,
      }),
      EXECUTOR_APP_ORIGIN: hosts.browser,
      EXECUTOR_MCP_ORIGIN: hosts.resourceOrigins.mcp[0],
      EXECUTOR_API_ORIGIN: Option.match(hosts.roles, {
        onNone: () => hosts.deployment,
        onSome: (roles) => roles.origins.api,
      }),
      PUBLIC_EXECUTOR_COOKIE_DOMAIN: Option.getOrElse(hosts.sharedCookieDomain, () => ""),
      VITE_CHATGPT_SIGN_IN: String(Option.isSome(yield* chatGptSettings.pipe(Effect.orDie))),
      ...Option.match(notes, {
        onNone: () => ({}),
        onSome: (json) => ({ EXECUTOR_CLOUD_RELEASE_NOTES: json }),
      }),
    },
  });
});
