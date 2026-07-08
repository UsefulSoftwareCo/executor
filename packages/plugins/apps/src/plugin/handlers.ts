/* oxlint-disable executor/no-effect-escape-hatch -- boundary: HttpApi handler adapter maps plugin extension failures into InternalError */
import { Context, Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { addGroup, capture } from "@executor-js/api";
import { InternalError } from "@executor-js/sdk/shared";
import type { AppsExtension } from "./apps-plugin";
import { AppsBaseGroup, AppsGroup } from "./routes";

export class AppsExtensionService extends Context.Service<AppsExtensionService, AppsExtension>()(
  "AppsExtensionService",
) {}

const ExecutorApiWithAppsBase = addGroup(AppsBaseGroup);
const ExecutorApiWithApps = addGroup(AppsGroup);

const captureUnexpected = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, InternalError, R> =>
  capture(effect.pipe(Effect.catch((cause: unknown) => Effect.die(cause))));

export const AppsBaseHandlers = HttpApiBuilder.group(ExecutorApiWithAppsBase, "apps", (handlers) =>
  handlers
    .handle("listSources", () =>
      captureUnexpected(
        Effect.gen(function* () {
          const ext = yield* AppsExtensionService;
          const sources = yield* ext.listSources();
          return { sources };
        }),
      ),
    )
    .handle("createSource", ({ payload }) =>
      captureUnexpected(
        Effect.gen(function* () {
          const ext = yield* AppsExtensionService;
          const source = yield* ext.createSource(payload);
          return { source };
        }),
      ),
    )
    .handle("getSource", ({ params }) =>
      captureUnexpected(
        Effect.gen(function* () {
          const ext = yield* AppsExtensionService;
          const source = yield* ext.getSource(params.slug);
          return { source };
        }),
      ),
    )
    .handle("deleteSource", ({ params }) =>
      captureUnexpected(
        Effect.gen(function* () {
          const ext = yield* AppsExtensionService;
          return yield* ext.deleteSource(params.slug);
        }),
      ),
    )
    .handle("syncSource", ({ params }) =>
      captureUnexpected(
        Effect.gen(function* () {
          const ext = yield* AppsExtensionService;
          return yield* ext.syncSource(params.slug);
        }),
      ),
    ),
);

export const AppsHandlers = HttpApiBuilder.group(ExecutorApiWithApps, "apps", (handlers) =>
  handlers
    .handle("listSources", () =>
      captureUnexpected(
        Effect.gen(function* () {
          const ext = yield* AppsExtensionService;
          const sources = yield* ext.listSources();
          return { sources };
        }),
      ),
    )
    .handle("createSource", ({ payload }) =>
      captureUnexpected(
        Effect.gen(function* () {
          const ext = yield* AppsExtensionService;
          const source = yield* ext.createSource(payload);
          return { source };
        }),
      ),
    )
    .handle("getSource", ({ params }) =>
      captureUnexpected(
        Effect.gen(function* () {
          const ext = yield* AppsExtensionService;
          const source = yield* ext.getSource(params.slug);
          return { source };
        }),
      ),
    )
    .handle("deleteSource", ({ params }) =>
      captureUnexpected(
        Effect.gen(function* () {
          const ext = yield* AppsExtensionService;
          return yield* ext.deleteSource(params.slug);
        }),
      ),
    )
    .handle("syncSource", ({ params }) =>
      captureUnexpected(
        Effect.gen(function* () {
          const ext = yield* AppsExtensionService;
          return yield* ext.syncSource(params.slug);
        }),
      ),
    )
    .handle("listDirs", ({ query }) =>
      captureUnexpected(
        Effect.gen(function* () {
          const ext = yield* AppsExtensionService;
          return yield* ext.listDirs({
            ...(query.path ? { path: query.path } : {}),
            includeHidden: query.includeHidden === "true" || query.includeHidden === "1",
          });
        }),
      ),
    ),
);

export const appsHandlersForSourceKinds = (
  sourceKinds: readonly ("git" | "local-directory")[] | undefined,
) => ((sourceKinds?.includes("local-directory") ?? true) ? AppsHandlers : AppsBaseHandlers);
