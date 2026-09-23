/** Native webhook dispatch. The author verifies signatures before parsing or performing side effects. */
import { Cause, Effect, Encoding, Schema, Stream } from "effect";
import type { AppDefinition } from "../contracts/app.ts";
import {
  HostDeclarationInvalid,
  HostInputInvalid,
  HostOperationFailed,
  HostOperationNotFound,
  HostOutputInvalid,
  type ResolvedAccounts,
} from "../contracts/host.ts";
import {
  defaultWebhookTransportLimits,
  HostedWebhook,
  ManualWebhookSetup,
  WebhookResponseData,
  type WebhookCommand,
} from "../contracts/webhook-protocol.ts";
import { JsonObject, JsonValue } from "../contracts/schema.ts";
import { importedJsonSchema } from "./schema.ts";

const safe = <A, E>(work: () => Effect.Effect<A, unknown>, error: E) =>
  Effect.suspend(work).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(error),
    ),
  );
/** Run one hook with freshly bound context. No credentials or raw failures enter the response envelope. */
export const dispatchWebhook = <
  Context extends {
    readonly signal?: AbortSignal;
    readonly accounts: Readonly<Record<string, unknown>>;
  },
>(
  definition: AppDefinition<Context>,
  command: WebhookCommand,
  context: Context,
  accounts: ResolvedAccounts,
) =>
  Effect.gen(function* () {
    const hooks = definition.webhooks ?? {};
    if (command.operation === "webhooks") {
      return yield* Effect.forEach(Object.entries(hooks), ([name, hook]) =>
        safe(
          () =>
            Effect.gen(function* () {
              if (!Object.hasOwn(accounts, hook.account))
                return yield* new HostDeclarationInvalid();
              const describe = (schema: Schema.Decoder<unknown>) => {
                const imported = importedJsonSchema(schema);
                if (imported !== undefined) return Schema.decodeUnknownEffect(JsonObject)(imported);
                const document = Schema.toJsonSchemaDocument(schema);
                return Schema.decodeUnknownEffect(JsonObject)({
                  ...document.schema,
                  $defs: document.definitions,
                });
              };
              const configSchema = yield* describe(hook.config);
              if (
                hook.setup === undefined
                  ? hook.register === undefined || hook.unregister === undefined
                  : hook.register !== undefined || hook.unregister !== undefined
              )
                return yield* new HostDeclarationInvalid();
              const setup =
                hook.setup === undefined
                  ? undefined
                  : {
                      ...(yield* Schema.decodeUnknownEffect(ManualWebhookSetup)(hook.setup)),
                      stateSchema: yield* describe(hook.state),
                    };
              return yield* Schema.decodeUnknownEffect(HostedWebhook)({
                name,
                account: hook.account,
                configSchema,
                ...(setup === undefined ? {} : { setup }),
              });
            }),
          new HostDeclarationInvalid(),
        ),
      );
    }
    const hook = Object.hasOwn(hooks, command.name) ? hooks[command.name] : undefined;
    if (hook === undefined) return yield* new HostOperationNotFound();
    const selected = accounts[hook.account];
    const source = Array.isArray(selected)
      ? selected.find((account) => account.id === command.sourceAccount)
      : selected;
    if (source === undefined || source.id !== command.sourceAccount)
      return yield* new HostInputInvalid();
    const bound = context.accounts[hook.account];
    const account = Array.isArray(bound)
      ? bound.find(
          (value) =>
            typeof value === "object" && value !== null && "id" in value && value.id === source.id,
        )
      : bound;
    const config = yield* safe(
      () => Schema.decodeUnknownEffect(hook.config)(command.config),
      new HostInputInvalid(),
    );
    if (command.operation === "webhook-validate")
      return yield* safe(
        () => Schema.decodeUnknownEffect(JsonValue)(config),
        new HostInputInvalid(),
      );
    const input = {
      config,
      subscriptionId: command.subscriptionId,
      account,
      callbackUrl: command.callbackUrl,
      secret: command.secret,
    };
    // SAFETY: each erased callback's schema is decoded here before invocation. The authoring boundary
    // preserves its context/input relationship, which a heterogeneous catalog cannot express.
    const invoke = (
      callback: (context: Context, input: never) => Effect.Effect<unknown, unknown>,
      value: unknown,
    ) => safe(() => callback(context, value as never), new HostOperationFailed());
    if (command.operation === "webhook-complete") {
      if (hook.setup === undefined) return yield* new HostInputInvalid();
      return yield* safe(
        () =>
          Schema.decodeUnknownEffect(hook.state)(command.state).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(JsonValue)),
          ),
        new HostInputInvalid(),
      );
    }
    if (command.operation === "webhook-register") {
      if (hook.register === undefined || hook.setup !== undefined)
        return yield* new HostOperationFailed();
      const state = yield* invoke(hook.register, input);
      return yield* safe(
        () =>
          Schema.decodeUnknownEffect(hook.state)(state).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(JsonValue)),
          ),
        new HostOutputInvalid(),
      );
    }
    const state =
      command.state === null
        ? null
        : yield* safe(
            () => Schema.decodeUnknownEffect(hook.state)(command.state),
            new HostInputInvalid(),
          );
    if (command.operation === "webhook-unregister") {
      if (hook.unregister === undefined || hook.setup !== undefined)
        return yield* new HostOperationFailed();
      yield* invoke(hook.unregister, { ...input, state });
      return null;
    }
    const body = yield* Effect.fromResult(Encoding.decodeBase64(command.request.body)).pipe(
      Effect.mapError(() => new HostInputInvalid()),
    );
    if (body.byteLength > defaultWebhookTransportLimits.maxBodyBytes)
      return yield* new HostInputInvalid();
    const request = yield* safe(
      () =>
        Effect.sync(
          () =>
            new Request(command.request.url, {
              method: command.request.method,
              headers: command.request.headers,
              ...(context.signal === undefined ? {} : { signal: context.signal }),
              ...(command.request.method === "GET" || command.request.method === "HEAD"
                ? {}
                : { body: Uint8Array.from(body) }),
            }),
        ),
      new HostInputInvalid(),
    );
    const response = yield* invoke(hook.handle, { ...input, state, request });
    if (!(response instanceof Response)) return yield* new HostOutputInvalid();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const stream = response.body;
    if (stream !== null)
      yield* Stream.fromReadableStream({
        evaluate: () => stream,
        onError: () => new HostOutputInvalid(),
      }).pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            size += chunk.byteLength;
            if (size > defaultWebhookTransportLimits.maxBodyBytes)
              return yield* new HostOutputInvalid();
            chunks.push(chunk);
          }),
        ),
      );
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    return yield* safe(
      () =>
        Schema.decodeUnknownEffect(WebhookResponseData)({
          status: response.status,
          headers,
          body: Encoding.encodeBase64(new Uint8Array(bytes)),
        }),
      new HostOutputInvalid(),
    );
  });
