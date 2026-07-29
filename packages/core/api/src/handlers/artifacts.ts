import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import {
  sanitizeArtifactPreviewMarkup,
  type Artifact,
  type ArtifactSummary,
} from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor-js/api";

const summaryToResponse = (a: ArtifactSummary) => ({
  id: a.id,
  owner: a.owner,
  title: a.title,
  description: a.description,
  preview: a.preview,
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
    )
    .handle("setPreview", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          // This markup came from a BROWSER, not from this server's own
          // sandbox, so it is sanitized here before it is stored — through the
          // same allowlist the create-time preview goes through, which is what
          // makes the console safe to render either kind identically.
          //
          // A payload that sanitizes to nothing is reported as not stored
          // rather than as an error: the caller is a viewer who merely opened
          // an artifact, and the card simply keeps its layout preview.
          const sanitized = sanitizeArtifactPreviewMarkup(payload.preview);
          if (sanitized === null) return { stored: false };
          const executor = yield* ExecutorService;
          yield* executor.artifacts.setPreview({
            id: path.artifactId,
            preview: sanitized,
          });
          return { stored: true };
        }),
      ),
    ),
);
