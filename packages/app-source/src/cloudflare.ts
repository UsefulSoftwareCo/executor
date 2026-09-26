/**
 * Git access to Cloudflare Artifacts through host-owned repository credentials.
 * isomorphic-git and its in-memory filesystem load with the first repository
 * operation, so Worker startup and requests that never touch app source skip them.
 */
import { Effect } from "effect";
import type { AppCodeId, RepositoryBackend } from "./contracts/repositories.ts";
import type { ArtifactsTokens } from "./contracts/artifacts-tokens.ts";
export type { ArtifactsToken, ArtifactsTokens } from "./contracts/artifacts-tokens.ts";

/** Managed repository credentials remain behind the host-owned token coordinator. */
export const cloudflareRepositories = (
  tokens: ArtifactsTokens,
  settings: { readonly accountId: string; readonly namespace: string },
): RepositoryBackend => {
  // The backend is stateless and cheap to construct; the module loader keeps the loaded module.
  const backend = Effect.promise(() => import("./implementation/cloudflare-git.ts")).pipe(
    Effect.map((git) => git.cloudflareRepositories(tokens, settings)),
  );
  return {
    history: (id: AppCodeId) => Effect.flatMap(backend, (git) => git.history(id)),
    create: (id) => Effect.flatMap(backend, (git) => git.create(id)),
    head: (id, branch) => Effect.flatMap(backend, (git) => git.head(id, branch)),
    read: (id, ref) => Effect.flatMap(backend, (git) => git.read(id, ref)),
    commit: (input) => Effect.flatMap(backend, (git) => git.commit(input)),
    request: (id, request) => Effect.flatMap(backend, (git) => git.request(id, request)),
  };
};
