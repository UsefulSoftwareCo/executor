/** One build owns the shared marketing, docs and dashboard output. */
import * as Command from "alchemy/Command";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Stage } from "alchemy/Stage";
import { Effect, Option } from "effect";
import { chatGptSettings } from "../implementation/chatgpt-sign-in.ts";
import { postHogBindings } from "./posthog.ts";
import { sentryBindings } from "./sentry.ts";
import { cloudHosts } from "./stage.ts";

/** Alchemy reuses this resource when the API and development server request it. */
export const cloudSite = Effect.gen(function* () {
  const analytics = yield* postHogBindings;
  const sentry = yield* sentryBindings;
  // Pages label their browser telemetry with the environment the Worker's telemetry uses: the
  // stage when deployed, and the development process's own setting otherwise.
  const environment = (yield* AlchemyContext).dev ? {} : { EXECUTOR_ENVIRONMENT: yield* Stage };
  // The site is served from the edge (`executor.sh`), its canonical origin; sign-in links open
  // the browser origin (`app.executor.sh`). `/api/*` on the edge belongs to v1, so the site reads
  // the public app registry from the API host (`api.executor.sh`).
  const hosts = yield* cloudHosts.pipe(Effect.orDie);
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
      EXECUTOR_API_ORIGIN: Option.match(hosts.roles, {
        onNone: () => hosts.deployment,
        onSome: (roles) => roles.origins.api,
      }),
      PUBLIC_EXECUTOR_COOKIE_DOMAIN: Option.getOrElse(hosts.sharedCookieDomain, () => ""),
      VITE_CHATGPT_SIGN_IN: String(Option.isSome(yield* chatGptSettings.pipe(Effect.orDie))),
    },
  });
});
