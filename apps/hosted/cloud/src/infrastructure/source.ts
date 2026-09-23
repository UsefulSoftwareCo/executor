/** Cloud app source uses the same Git revision contract as native hosts. */
import { gitSourceStorage } from "@executor-js/app-source";
import { cloudflareRepositories, type ArtifactsTokens } from "@executor-js/app-source/cloudflare";
import { Config, Effect, Schema } from "effect";
import { cloudSourceNamespace } from "./artifacts-tokens.ts";

/** Resolve bindings during composition; each Git operation remains scoped to its invocation. */
export const cloudAppSources = (tokens: ArtifactsTokens) =>
  Effect.gen(function* () {
    const accountId = yield* Config.String("CLOUDFLARE_ACCOUNT_ID").pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/))),
      ),
    );
    const namespace = yield* cloudSourceNamespace;
    const repositories = cloudflareRepositories(tokens, { accountId, namespace });
    return { repositories, sources: gitSourceStorage(repositories) };
  }).pipe(Effect.orDie);
