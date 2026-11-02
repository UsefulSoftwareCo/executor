/** Adapt app author handlers once; dispatch them with the requiring app's bound context. */
import { Effect, Schema } from "effect";
import type { AppRequirements, AppContext, RequirementSlots } from "../contracts/context.ts";
import type { ScopedSlots, AccountSlots, BoundAccounts } from "../contracts/app.ts";
import {
  ManyAccounts,
  type InteractiveMethod,
  type Provider,
  type AuthMethods,
} from "../contracts/provider.ts";
import {
  ConnectCommand,
  InteractiveStart,
  InteractiveStatus,
  type ConnectHandlers,
} from "../contracts/connect.ts";
import {
  HostInputInvalid,
  HostOperationFailed,
  HostOperationNotFound,
  HostOutputInvalid,
} from "../contracts/host.ts";
import { JsonValue } from "../contracts/schema.ts";
import { fromPromise, method, type PromiseMethods } from "./authoring.ts";
import type { Sql } from "../contracts/sql.ts";

type Slots<R extends AppRequirements> = RequirementSlots<R>["app"] & RequirementSlots<R>["user"];
type Methods<P> = P extends Provider<infer A> | ManyAccounts<infer A>
  ? { [K in keyof A & string]: A[K] extends InteractiveMethod ? K : never }[keyof A & string]
  : never;
type ConnectAccounts<S extends AccountSlots> = {
  readonly [
    K in keyof S as S[K] extends ManyAccounts<AuthMethods> ? K : never
  ]: BoundAccounts<S>[K];
} & {
  readonly [
    K in keyof S as S[K] extends ManyAccounts<AuthMethods> ? never : K
  ]?: BoundAccounts<S>[K];
};
/** Connecting must work before all requirements are filled. Linked accounts retain their types. */
export type ConnectContext<R extends AppRequirements> = Omit<AppContext<R>, "app" | "user"> & {
  readonly app: { readonly accounts: ConnectAccounts<RequirementSlots<R>["app"]> };
  readonly user: Omit<AppContext<R>["user"], "accounts"> & {
    readonly accounts: ConnectAccounts<RequirementSlots<R>["user"]>;
  };
  readonly sql: Sql;
};
export type AuthorConnect<R extends AppRequirements> = {
  readonly [
    S in keyof Slots<R> & string as Methods<Slots<R>[S]> extends never ? never : S
  ]: PromiseMethods<ConnectHandlers<ConnectContext<R>, Methods<Slots<R>[S]>>>;
};

/** Fail static builds and dynamic inspection when declarations and handlers disagree. */
export function validateConnect(
  slots: ScopedSlots,
  handlers: Readonly<Record<string, unknown>> | undefined,
): void {
  const required = new Set<string>();
  for (const [slot, selected] of Object.entries({ ...slots.app, ...slots.user })) {
    const provider = selected instanceof ManyAccounts ? selected.provider : selected;
    if (Object.values(provider.auth).some((method) => method._tag === "interactive"))
      required.add(slot);
  }
  for (const slot of required) {
    const handler = handlers?.[slot];
    if (
      typeof handler !== "object" ||
      handler === null ||
      !("start" in handler) ||
      typeof handler.start !== "function" ||
      !("status" in handler) ||
      typeof handler.status !== "function"
    )
      throw new TypeError(
        `Interactive account requirement ${JSON.stringify(slot)} needs connect.start and connect.status handlers`,
      );
  }
  for (const slot of Object.keys(handlers ?? {}))
    if (!required.has(slot))
      throw new TypeError(
        `Connect handlers ${JSON.stringify(slot)} need an interactive account requirement`,
      );
}

/** Object iteration erases the slot's type; adaptation preserves each callback's arguments. */
export const authorConnect = (
  handlers: Readonly<Record<string, PromiseMethods<ConnectHandlers<never, never>>>>,
) =>
  Object.fromEntries(
    Object.entries(handlers).map(([slot, handler]) => [
      slot,
      {
        start: fromPromise(method(handler, "start"), "connect"),
        status: fromPromise(method(handler, "status"), "connect"),
        ...(handler.submit === undefined
          ? {}
          : {
              submit: fromPromise(method(handler as Required<typeof handler>, "submit"), "connect"),
            }),
        ...(handler.cancel === undefined
          ? {}
          : {
              cancel: fromPromise(method(handler as Required<typeof handler>, "cancel"), "connect"),
            }),
        ...(handler.remove === undefined
          ? {}
          : {
              remove: fromPromise(method(handler as Required<typeof handler>, "remove"), "connect"),
            }),
      },
    ]),
  );

export const dispatchConnect = <C>(
  handlers: Readonly<Record<string, ConnectHandlers<C>>> | undefined,
  command: ConnectCommand,
  context: C,
) =>
  Effect.gen(function* () {
    const handler =
      handlers !== undefined && Object.hasOwn(handlers, command.slot)
        ? handlers[command.slot]
        : undefined;
    if (handler === undefined) return yield* new HostOperationNotFound();
    let result: unknown;
    switch (command.step) {
      case "start":
        result = yield* handler.start(context, command.input);
        break;
      case "status":
        result = yield* handler.status(context, command.input);
        break;
      case "submit":
        if (handler.submit === undefined) return yield* new HostInputInvalid();
        result = yield* handler.submit(context, command.input);
        break;
      case "cancel":
        yield* handler.cancel?.(context, command.input) ?? Effect.void;
        return null;
      case "remove":
        yield* handler.remove?.(context, command.input) ?? Effect.void;
        return null;
    }
    return yield* Schema.decodeUnknownEffect(
      command.step === "start" ? InteractiveStart : InteractiveStatus,
    )(result).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(JsonValue)),
      Effect.mapError(() => new HostOutputInvalid()),
    );
  }).pipe(
    Effect.mapError((error) =>
      Schema.is(HostOperationNotFound)(error) ||
      Schema.is(HostInputInvalid)(error) ||
      Schema.is(HostOutputInvalid)(error)
        ? error
        : new HostOperationFailed({}),
    ),
  );
