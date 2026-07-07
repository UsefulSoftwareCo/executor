import { Context, Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { addGroup, capture } from "@executor-js/api";
import type { AppsPluginExtension } from "./apps-plugin";
import { AppsGroup } from "./routes";

export class AppsExtensionService extends Context.Service<
  AppsExtensionService,
  AppsPluginExtension
>()("AppsExtensionService") {}

const ExecutorApiWithApps = addGroup(AppsGroup);

export const AppsHandlers = HttpApiBuilder.group(ExecutorApiWithApps, "apps", (handlers) =>
  handlers
    .handle("listGithubSources", () =>
      capture(
        Effect.gen(function* () {
          const ext = yield* AppsExtensionService;
          return yield* ext.listGitHubSources();
        }),
      ),
    )
    .handle("syncGithubSource", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* AppsExtensionService;
          return yield* ext.syncGitHubSource(payload);
        }),
      ),
    )
    .handle("getGithubSource", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* AppsExtensionService;
          return yield* ext.getGitHubSource(params.slug);
        }),
      ),
    )
    .handle("removeGithubSource", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* AppsExtensionService;
          return yield* ext.removeGitHubSource(params.slug);
        }),
      ),
    ),
);
