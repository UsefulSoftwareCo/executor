import { cloudflareRepositories, type ArtifactsTokens } from "@executor-js/app-source/cloudflare";
import type { RepositoryBackend } from "@executor-js/sdk/core";
import { Config, Effect, Schema } from "effect";
import { cachedWorkspaces } from "../implementation/workspace-cache.ts";
import { cloudSourceNamespace } from "./artifacts-tokens.ts";
import { cloudWorkspaceObjects } from "./blobs.ts";

export type AppSources = (
  background: (work: Effect.Effect<void>) => Effect.Effect<boolean>,
) => RepositoryBackend;

export const cloudAppSources = (tokens: ArtifactsTokens) =>
  Effect.gen(function* () {
    const accountId = yield* Config.String("CLOUDFLARE_ACCOUNT_ID").pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u))),
      ),
    );
    const namespace = yield* cloudSourceNamespace;
    const git = cloudflareRepositories(tokens, { accountId, namespace });
    const workspaces = yield* cloudWorkspaceObjects;
    const sources: AppSources = (background) => cachedWorkspaces(git, workspaces, background);
    return sources;
  }).pipe(Effect.orDie);
