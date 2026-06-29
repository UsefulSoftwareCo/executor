import type { WorkOS } from "@workos-inc/node/worker";
import {
  GenericServerException,
  NotFoundException,
  WorkOS as WorkOSClient,
} from "@workos-inc/node/worker";
import { Data, Effect, Option, Result, Schema } from "effect";

export interface WorkOSVaultObjectMetadata {
  readonly context: Record<string, unknown>;
  readonly id: string;
  readonly updatedAt: Date;
  readonly versionId: string;
}

export interface WorkOSVaultObject {
  readonly id: string;
  readonly metadata: WorkOSVaultObjectMetadata;
  readonly name: string;
  readonly value?: string;
}

const WORKOS_KEK_NOT_READY_MESSAGE =
  "KEK was created but is not yet ready. This request can be retried.";

const CauseWithStatusSchema = Schema.Struct({
  status: Schema.Number,
});
const decodeCauseWithStatusOption = Schema.decodeUnknownOption(CauseWithStatusSchema);

const statusFromWorkOSCause = (cause: unknown): number | undefined => {
  if (cause instanceof GenericServerException || cause instanceof NotFoundException) {
    return cause.status;
  }
  return Option.match(decodeCauseWithStatusOption(cause), {
    onNone: () => undefined,
    onSome: (decoded) => decoded.status,
  });
};

const isKekNotReadyWorkOSCause = (cause: unknown): boolean =>
  cause instanceof GenericServerException &&
  // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: WorkOS only exposes this retryable Vault condition through its SDK exception message
  cause.message.endsWith(WORKOS_KEK_NOT_READY_MESSAGE);

export class WorkOSVaultClientError extends Data.TaggedError("WorkOSVaultClientError")<{
  readonly cause: unknown;
  readonly message: string;
  readonly operation: string;
  readonly retryKind?: "kek_not_ready";
  readonly status?: number;
}> {
  constructor(options: {
    readonly cause: unknown;
    readonly message?: string;
    readonly operation: string;
    readonly retryKind?: "kek_not_ready";
    readonly status?: number;
  }) {
    super({
      cause: options.cause,
      message: options.message ?? `WorkOS Vault ${options.operation} failed`,
      operation: options.operation,
      retryKind:
        options.retryKind ??
        (isKekNotReadyWorkOSCause(options.cause) ? "kek_not_ready" : undefined),
      status: options.status ?? statusFromWorkOSCause(options.cause),
    });
  }
}

export class WorkOSVaultClientInstantiationError extends Data.TaggedError(
  "WorkOSVaultClientInstantiationError",
)<{
  readonly cause: unknown;
}> {}

// Promise-shaped facade onto the underlying WorkOS SDK. Module-private — the
// public surface in `WorkOSVaultClient` is Effect-only. Test doubles import
// this type to stand up an in-memory equivalent.
export interface WorkOSVaultPromiseApi {
  readonly createObject: (options: {
    readonly name: string;
    readonly value: string;
    readonly context: Record<string, string>;
  }) => Promise<WorkOSVaultObjectMetadata>;
  readonly readObjectByName: (name: string) => Promise<WorkOSVaultObject>;
  readonly updateObject: (options: {
    readonly id: string;
    readonly value: string;
    readonly versionCheck?: string;
  }) => Promise<WorkOSVaultObject>;
  readonly deleteObject: (options: { readonly id: string }) => Promise<void>;
}

export interface WorkOSVaultCredentials {
  readonly apiKey: string;
  readonly clientId: string;
  /** Optional WorkOS API base-URL override (e.g. a WorkOS emulator in tests). */
  readonly apiUrl?: string;
}

const apiUrlOptions = (
  url: string | undefined,
): { apiHostname?: string; port?: number; https?: boolean } => {
  if (!url) return {};
  const parsed = new URL(url);
  return {
    apiHostname: parsed.hostname,
    ...(parsed.port ? { port: Number(parsed.port) } : {}),
    https: parsed.protocol === "https:",
  };
};

interface WorkOSVaultUseOptions {
  readonly expectedErrorStatuses?: readonly number[];
  readonly expectedErrorOutcome?: string;
}

export interface WorkOSVaultClient {
  readonly use: <A>(
    operation: string,
    fn: (client: WorkOSVaultPromiseApi) => Promise<A>,
    options?: WorkOSVaultUseOptions,
  ) => Effect.Effect<A, WorkOSVaultClientError, never>;
  readonly createObject: (options: {
    readonly name: string;
    readonly value: string;
    readonly context: Record<string, string>;
  }) => Effect.Effect<WorkOSVaultObjectMetadata, WorkOSVaultClientError, never>;
  readonly readObjectByName: (
    name: string,
  ) => Effect.Effect<WorkOSVaultObject, WorkOSVaultClientError, never>;
  readonly updateObject: (options: {
    readonly id: string;
    readonly value: string;
    readonly versionCheck?: string;
  }) => Effect.Effect<WorkOSVaultObject, WorkOSVaultClientError, never>;
  readonly deleteObject: (options: {
    readonly id: string;
  }) => Effect.Effect<void, WorkOSVaultClientError, never>;
}

const isExpectedVaultError = (
  error: WorkOSVaultClientError,
  options: WorkOSVaultUseOptions | undefined,
): boolean => {
  if (error.status === undefined) return false;
  return options?.expectedErrorStatuses?.includes(error.status) ?? false;
};

export const makeWorkOSVaultClient = (workos: Pick<WorkOS, "vault">): WorkOSVaultClient => {
  const client: WorkOSVaultPromiseApi = workos.vault;

  const use = <A>(
    operation: string,
    fn: (vault: WorkOSVaultPromiseApi) => Promise<A>,
    options?: WorkOSVaultUseOptions,
  ): Effect.Effect<A, WorkOSVaultClientError, never> => {
    const attempt = Effect.tryPromise({
      try: () => fn(client),
      catch: (cause) => new WorkOSVaultClientError({ cause, operation }),
    });

    const observed = attempt.pipe(
      Effect.result,
      Effect.flatMap((outcome) =>
        Effect.gen(function* () {
          if (Result.isSuccess(outcome)) {
            yield* Effect.annotateCurrentSpan({ "workos_vault.outcome": "ok" });
            return outcome;
          }

          const status = outcome.failure.status;
          if (isExpectedVaultError(outcome.failure, options)) {
            yield* Effect.annotateCurrentSpan({
              "workos_vault.outcome": options?.expectedErrorOutcome ?? "expected_error",
              "workos_vault.status": status ?? "unknown",
            });
            return outcome;
          }

          yield* Effect.annotateCurrentSpan({
            "workos_vault.outcome": "error",
            "workos_vault.status": status ?? "unknown",
          });
          return yield* Effect.fail(outcome.failure);
        }),
      ),
      Effect.withSpan(`workos_vault.${operation}`),
    );

    return observed.pipe(
      Effect.flatMap((outcome) =>
        Result.isSuccess(outcome) ? Effect.succeed(outcome.success) : Effect.fail(outcome.failure),
      ),
    );
  };

  return {
    use,
    createObject: (options) => use("create_object", (vault) => vault.createObject(options)),
    readObjectByName: (name) =>
      use("read_object_by_name", (vault) => vault.readObjectByName(name), {
        expectedErrorOutcome: "expected_missing_object",
        expectedErrorStatuses: [400, 404],
      }),
    updateObject: (options) => use("update_object", (vault) => vault.updateObject(options)),
    deleteObject: (options) => use("delete_object", (vault) => vault.deleteObject(options)),
  };
};

export const makeConfiguredWorkOSVaultClient = (
  credentials: WorkOSVaultCredentials,
): Effect.Effect<WorkOSVaultClient, WorkOSVaultClientInstantiationError, never> =>
  Effect.try({
    try: () =>
      makeWorkOSVaultClient(
        new WorkOSClient({
          apiKey: credentials.apiKey,
          clientId: credentials.clientId,
          ...apiUrlOptions(credentials.apiUrl),
        }),
      ),
    catch: (cause) => new WorkOSVaultClientInstantiationError({ cause }),
  }).pipe(Effect.withSpan("workos_vault.make_client"));
