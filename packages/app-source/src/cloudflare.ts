import { Effect } from "effect";
import type { AppCodeId, RepositoryBackend } from "@executor-js/sdk/core";
import type { ArtifactsTokens } from "./contracts/artifacts-tokens.ts";
export type { ArtifactsToken, ArtifactsTokens } from "./contracts/artifacts-tokens.ts";

export const cloudflareRepositories = (
  tokens: ArtifactsTokens,
  settings: { readonly accountId: string; readonly namespace: string },
): RepositoryBackend => {
  const backend = Effect.promise(() => import("./implementation/cloudflare-git.ts")).pipe(
    Effect.map((git) => git.cloudflareRepositories(tokens, settings)),
  );
  return {
    history: (id: AppCodeId) => Effect.flatMap(backend, (git) => git.history(id)),
    create: (id) => Effect.flatMap(backend, (git) => git.create(id)),
    head: (id, branch) => Effect.flatMap(backend, (git) => git.head(id, branch)),
    read: (id, ref) => Effect.flatMap(backend, (git) => git.read(id, ref)),
    commit: (input) => Effect.flatMap(backend, (git) => git.commit(input)),
    blob: (id, object) => Effect.flatMap(backend, (git) => git.blob(id, object)),
    file: (id, commit, path) => Effect.flatMap(backend, (git) => git.file(id, commit, path)),
    request: (id, request) => Effect.flatMap(backend, (git) => git.request(id, request)),
  };
};
