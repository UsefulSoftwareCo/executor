/** Shared Postgres configuration and SDK construction; hosts own driver lifetimes. */
import {
  aesGcmCredentials,
  createExecutor,
  makeExecutorStorage,
  type AppRuntime,
  type BlobStorage,
  type AppSourceStorage,
  type OAuthOptions,
  type ExecutorOptions,
} from "@executor-js/sdk/core";
import { Config, Effect, type Redacted, Schema } from "effect";

/** Explicit connection URL shared by Better Auth and Executor; never logged or returned. */
export const databaseUrl = Config.Redacted("DATABASE_URL").pipe(
  Effect.flatMap(
    Schema.decodeUnknownEffect(
      Schema.Redacted(
        Schema.String.check(
          Schema.makeFilter(
            (value) => {
              try {
                const url = new URL(value);
                return (
                  (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
                  url.hostname.length > 0 &&
                  url.pathname.length > 1
                );
              } catch {
                return false;
              }
            },
            { message: "DATABASE_URL must identify a Postgres database" },
          ),
        ),
      ),
    ),
  ),
);

/** Public SDK over the supplied Postgres SQL client. Migrations run separately. */
export const postgresExecutor = (
  secret: Redacted.Redacted<string>,
  runtime: AppRuntime,
  blobs: BlobStorage,
  sources: AppSourceStorage,
  oauth: Pick<OAuthOptions, "httpClient" | "clientMetadataUrl" | "urlPolicy">,
  options?: Partial<
    Pick<ExecutorOptions, "storage" | "appStorage" | "webhookOrigin" | "workflows">
  >,
) =>
  Effect.gen(function* () {
    const storage = options?.storage ?? (yield* makeExecutorStorage({ provider: "postgresql" }));
    const credentials = yield* aesGcmCredentials(secret, globalThis.crypto);
    return yield* createExecutor({
      storage,
      ...(options?.workflows === undefined ? {} : { workflows: options.workflows }),
      ...(options?.webhookOrigin === undefined ? {} : { webhookOrigin: options.webhookOrigin }),
      ...(options?.appStorage === undefined ? {} : { appStorage: options.appStorage }),
      blobs,
      sources,
      credentials,
      runtime,
      oauth: {
        httpClient: oauth.httpClient,
        clientName: "Executor",
        urlPolicy: oauth.urlPolicy,
        ...(oauth.clientMetadataUrl === undefined
          ? {}
          : { clientMetadataUrl: oauth.clientMetadataUrl }),
      },
    });
  });
