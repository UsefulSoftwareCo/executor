import { Context, Duration, Effect, Schema, Semaphore } from "effect";

import { OnePasswordError } from "./errors";
import { opCliExec } from "./op-cli";
import type { OnePasswordSdkModule } from "./onepassword-sdk";

// ---------------------------------------------------------------------------
// Canonical service interface — all backends (SDK, CLI) implement this
// ---------------------------------------------------------------------------

export interface OnePasswordVault {
  readonly id: string;
  readonly title: string;
}

export interface OnePasswordItem {
  readonly id: string;
  readonly title: string;
}

export interface OnePasswordService {
  /** Resolve a secret by op:// URI */
  readonly resolveSecret: (uri: string) => Effect.Effect<string, OnePasswordError>;

  /** List accessible vaults */
  readonly listVaults: () => Effect.Effect<ReadonlyArray<OnePasswordVault>, OnePasswordError>;

  /** List items in a vault */
  readonly listItems: (
    vaultId: string,
  ) => Effect.Effect<ReadonlyArray<OnePasswordItem>, OnePasswordError>;
}

export class OnePasswordServiceTag extends Context.Service<
  OnePasswordServiceTag,
  OnePasswordService
>()("@executor-js/plugin-onepassword/OnePasswordService") {}

// ---------------------------------------------------------------------------
// Resolved auth — raw credentials ready for any backend
// ---------------------------------------------------------------------------

export type ResolvedAuth =
  | { readonly kind: "desktop-app"; readonly accountName: string }
  | { readonly kind: "service-account"; readonly token: string };

// ---------------------------------------------------------------------------
// SDK backend — uses @1password/sdk native IPC
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ERROR_MESSAGE_LENGTH = 300;
const SERVICE_ACCOUNT_TOKEN_RE = /ops_[A-Za-z0-9_-]+/g;

const formatCause = (cause: unknown): string => {
  // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: normalizing untyped op-js/SDK throwables into OnePasswordError.message
  const maybeMessage = (cause as { readonly message?: unknown } | null | undefined)?.message;
  const raw =
    // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: last-resort stringification of a non-Error throwable
    typeof maybeMessage === "string" && maybeMessage.length > 0 ? maybeMessage : String(cause);
  return raw
    .replace(SERVICE_ACCOUNT_TOKEN_RE, "[redacted 1Password token]")
    .replace(/\s+/g, " ")
    .trim();
};

const messageWithCause = (prefix: string, cause: unknown): string => {
  const causeMessage = formatCause(cause);
  const message = causeMessage ? `${prefix}: ${causeMessage}` : prefix;
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`
    : message;
};

const hasOnePasswordSdkShape = (value: unknown): value is OnePasswordSdkModule => {
  const sdk = value as Partial<OnePasswordSdkModule> | null | undefined;
  return typeof sdk?.createClient === "function" && typeof sdk.DesktopAuth === "function";
};

const invalidOnePasswordSdkError = () =>
  new OnePasswordError({
    operation: "sdk module load",
    message: [
      "Failed to load 1Password SDK: the packaged SDK module did not expose createClient and DesktopAuth.",
      "Install the 1Password CLI (`op`) in /opt/homebrew/bin or /usr/local/bin and retry, or update Executor.",
    ].join(" "),
  });

const loadOnePasswordSdk = (): Effect.Effect<OnePasswordSdkModule, OnePasswordError> =>
  Effect.tryPromise({
    try: () => import("./onepassword-sdk").then((module) => module.onePasswordSdk),
    catch: (cause) =>
      new OnePasswordError({
        operation: "sdk module load",
        message: messageWithCause("Failed to load 1Password SDK", cause),
      }),
  }).pipe(
    Effect.flatMap((sdk) =>
      hasOnePasswordSdkShape(sdk) ? Effect.succeed(sdk) : Effect.fail(invalidOnePasswordSdkError()),
    ),
  );

const makeTimeoutMessage = (operation: string, timeoutMs: number): string =>
  [
    `${operation}: timed out after ${Math.floor(timeoutMs / 1000)}s.`,
    "Troubleshooting:",
    "1. Make sure the 1Password desktop app is open and unlocked",
    "2. Check for an approval prompt in the 1Password app — it may be behind other windows",
    "3. Ensure 'Developer > Connect with 1Password CLI' is enabled in 1Password Settings",
    "4. Make sure no other app or terminal is waiting for 1Password approval (only one prompt at a time)",
    "5. Try quitting 1Password completely and reopening it, then retry",
  ].join("\n");

const timeoutWithOnePasswordError = (operation: string, timeoutMs: number) =>
  Effect.timeoutOrElse({
    duration: Duration.millis(timeoutMs),
    orElse: () =>
      Effect.fail(
        new OnePasswordError({
          operation,
          message: makeTimeoutMessage(operation, timeoutMs),
        }),
      ),
  });

export const makeNativeSdkService = (
  auth: ResolvedAuth,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Effect.Effect<OnePasswordService, OnePasswordError> =>
  Effect.gen(function* () {
    const sdk = yield* loadOnePasswordSdk().pipe(
      timeoutWithOnePasswordError("sdk module load", timeoutMs),
    );

    const client = yield* Effect.tryPromise({
      try: () =>
        sdk.createClient({
          auth: auth.kind === "desktop-app" ? new sdk.DesktopAuth(auth.accountName) : auth.token,
          integrationName: "Executor",
          integrationVersion: "0.0.0",
        }),
      catch: (cause) =>
        new OnePasswordError({
          operation: "client setup",
          message: messageWithCause("Failed to set up 1Password client", cause),
        }),
    }).pipe(timeoutWithOnePasswordError("client setup", timeoutMs));

    const wrap = <A>(fn: () => Promise<A>, operation: string): Effect.Effect<A, OnePasswordError> =>
      Effect.tryPromise({
        try: fn,
        catch: (cause) =>
          new OnePasswordError({
            operation,
            message: messageWithCause(`1Password SDK ${operation} failed`, cause),
          }),
      }).pipe(
        timeoutWithOnePasswordError(operation, timeoutMs),
        Effect.withSpan(`onepassword.sdk.${operation}`),
      );

    return OnePasswordServiceTag.of({
      resolveSecret: (uri) => wrap(() => client.secrets.resolve(uri), "secret resolution"),

      listVaults: () =>
        wrap(() => client.vaults.list({ decryptDetails: true }), "vault listing").pipe(
          Effect.map((vaults) => vaults.map((v) => ({ id: v.id, title: v.title }))),
        ),

      listItems: (vaultId) =>
        wrap(() => client.items.list(vaultId), "item listing").pipe(
          Effect.map((items) => items.map((i) => ({ id: i.id, title: i.title }))),
        ),
    });
  }).pipe(Effect.withSpan("onepassword.sdk.make_service"));

// ---------------------------------------------------------------------------
// CLI backend — spawns the `op` CLI asynchronously (see op-cli.ts for why the
// spawn must never be synchronous). Auth travels per spawn: the service
// account token goes through the child's environment and the desktop account
// through `--account`, so there is no process-global credential state.
// ---------------------------------------------------------------------------

/** The 1Password desktop app shows at most one CLI-authorization prompt at a
 *  time, so desktop-app spawns are serialized to keep concurrent calls from
 *  queueing invisible prompts behind each other. Service-account spawns never
 *  prompt and run unrestricted. */
const cliPromptLock = Semaphore.makeUnsafe(1);

const cliEnv = (auth: ResolvedAuth): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  // An inherited token would override `--account` and silently route a
  // desktop-app call to whatever service account the parent process carries.
  delete env["OP_SERVICE_ACCOUNT_TOKEN"];
  if (auth.kind === "service-account") env["OP_SERVICE_ACCOUNT_TOKEN"] = auth.token;
  return env;
};

const cliArgs = (auth: ResolvedAuth, base: readonly string[]): readonly string[] =>
  auth.kind === "desktop-app" ? [...base, `--account=${auth.accountName}`] : base;

const decodeCliVaultRows = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))),
);
const decodeCliItemRows = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String }))),
);

export const makeCliService = (
  auth: ResolvedAuth,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Effect.Effect<OnePasswordService, OnePasswordError> =>
  Effect.sync(() => {
    const run = (
      base: readonly string[],
      operation: string,
    ): Effect.Effect<string, OnePasswordError> => {
      const spawn = Effect.promise((signal) =>
        opCliExec({ args: cliArgs(auth, base), env: cliEnv(auth), timeoutMs, signal }),
      ).pipe(
        Effect.flatMap((result) => {
          if (result.ok) return Effect.succeed(result.stdout);
          return Effect.fail(
            result.timedOut
              ? new OnePasswordError({
                  operation,
                  message: makeTimeoutMessage(operation, timeoutMs),
                })
              : new OnePasswordError({
                  operation,
                  message: messageWithCause(`1Password CLI ${operation} failed`, result),
                }),
          );
        }),
      );
      return (auth.kind === "desktop-app" ? cliPromptLock.withPermits(1)(spawn) : spawn).pipe(
        Effect.withSpan(`onepassword.cli.${operation}`),
      );
    };

    const runJson = <A>(
      base: readonly string[],
      operation: string,
      decodeRows: (raw: string) => Effect.Effect<A, Schema.SchemaError>,
    ): Effect.Effect<A, OnePasswordError> =>
      run([...base, "--format=json"], operation).pipe(
        Effect.flatMap((raw) =>
          decodeRows(raw).pipe(
            Effect.mapError(
              (cause) =>
                new OnePasswordError({
                  operation,
                  message: messageWithCause(
                    `1Password CLI ${operation} returned unexpected output`,
                    cause,
                  ),
                }),
            ),
          ),
        ),
      );

    return OnePasswordServiceTag.of({
      // `op read` appends a trailing newline to the field value; strip it the
      // same way op-js's `read.parse` did so stored secrets stay unchanged.
      resolveSecret: (uri) =>
        run(["read", uri], "secret resolution").pipe(
          Effect.map((raw) => raw.replace(/[\r\n]+$/, "")),
        ),

      listVaults: () =>
        runJson(["vault", "list"], "vault listing", decodeCliVaultRows).pipe(
          Effect.map((vaults) => vaults.map((v) => ({ id: v.id, title: v.name }))),
        ),

      listItems: (vaultId) =>
        runJson(["item", "list", "--vault", vaultId], "item listing", decodeCliItemRows).pipe(
          Effect.map((items) => items.map((i) => ({ id: i.id, title: i.title }))),
        ),
    });
  }).pipe(Effect.withSpan("onepassword.cli.make_service"));

// ---------------------------------------------------------------------------
// Smart factory — tries CLI first (avoids IPC hang), falls back to SDK
// ---------------------------------------------------------------------------

const isCliUnavailable = (error: OnePasswordError): boolean => {
  // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OnePasswordError carries a typed `message`
  const message = error.message.toLowerCase();
  return (
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("command not found") ||
    message.includes("not installed") ||
    message.includes("no such file") ||
    message.includes("spawn op")
  );
};

const chooseFallbackError = (
  cliError: OnePasswordError,
  sdkError: OnePasswordError,
): OnePasswordError => (isCliUnavailable(cliError) ? sdkError : cliError);

export const makeOnePasswordService = (
  auth: ResolvedAuth,
  options?: { readonly preferSdk?: boolean; readonly timeoutMs?: number },
): Effect.Effect<OnePasswordService, OnePasswordError> => {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (options?.preferSdk) {
    return makeNativeSdkService(auth, timeoutMs);
  }

  return Effect.gen(function* () {
    const cliService = yield* makeCliService(auth, timeoutMs);
    const sdkService = yield* Effect.cached(makeNativeSdkService(auth, timeoutMs));

    const withSdkFallback = <A>(
      cliEffect: Effect.Effect<A, OnePasswordError>,
      sdkEffect: (service: OnePasswordService) => Effect.Effect<A, OnePasswordError>,
    ): Effect.Effect<A, OnePasswordError> =>
      cliEffect.pipe(
        Effect.catch((cliError: OnePasswordError) =>
          sdkService.pipe(
            Effect.flatMap(sdkEffect),
            Effect.mapError((sdkError: OnePasswordError) =>
              chooseFallbackError(cliError, sdkError),
            ),
          ),
        ),
      );

    return OnePasswordServiceTag.of({
      resolveSecret: (uri) =>
        withSdkFallback(cliService.resolveSecret(uri), (service) => service.resolveSecret(uri)),

      listVaults: () => withSdkFallback(cliService.listVaults(), (service) => service.listVaults()),

      listItems: (vaultId) =>
        withSdkFallback(cliService.listItems(vaultId), (service) => service.listItems(vaultId)),
    });
  }).pipe(Effect.withSpan("onepassword.make_service"));
};
