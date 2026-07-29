import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import type { Artifact, ArtifactSummary } from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor-js/api";

const summaryToResponse = (a: ArtifactSummary) => ({
  id: a.id,
  owner: a.owner,
  title: a.title,
  description: a.description,
  createdAt: a.createdAt.getTime(),
  updatedAt: a.updatedAt.getTime(),
});

const artifactToResponse = (a: Artifact) => ({
  ...summaryToResponse(a),
  code: a.code,
  bindings: a.bindings,
});

export const ArtifactsHandlers = HttpApiBuilder.group(ExecutorApi, "artifacts", (handlers) =>
  handlers
    .handle("list", () =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const artifacts = yield* executor.artifacts.list();
          return artifacts.map(summaryToResponse);
        }),
      ),
    )
    .handle("get", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const artifact = yield* executor.artifacts.get(path.artifactId);
          return artifactToResponse(artifact);
        }),
      ),
    )
    .handle("save", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const saved = yield* executor.artifacts.save({
            id: payload.id,
            title: payload.title,
            description: payload.description,
            code: payload.code,
            bindings: payload.bindings,
          });
          return artifactToResponse(saved);
        }),
      ),
    )
    .handle("rename", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const renamed = yield* executor.artifacts.rename({
            id: path.artifactId,
            title: payload.title,
          });
          return artifactToResponse(renamed);
        }),
      ),
    )
    .handle("remove", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          yield* executor.artifacts.remove({ id: path.artifactId });
          return { removed: true };
        }),
      ),
    ),
);
