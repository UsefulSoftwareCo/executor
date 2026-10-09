/** Event declarations and the per-invocation emitter. Emitted events leave in the reply. */
import { Effect, Schema as EffectSchema } from "effect";
import {
  defaultEventLimits,
  EmittedEvent,
  EventName,
  type AppEvent,
  type DeclaredEvents,
  type EmitOptions,
} from "../contracts/events.ts";
import type { JsonObject } from "../contracts/schema.ts";
import {
  decoderOf,
  jsonSchemaDocument,
  schemaArgument,
  type Fields,
  type Infer,
  type ObjectValue,
  type Schema,
} from "./schema.ts";

const Native = Symbol("apps.Event");

/** An event an app emits. Declare it in `defineApp`'s requirements under `events`. */
export interface EventDeclaration<F extends Fields, P extends Schema<unknown, boolean>> {
  readonly [Native]: AppEvent;
  readonly description: string;
  readonly filters: F;
  readonly payload: P;
}

/** Any declared event, for requirement constraints. */
export type AnyEventDeclaration = EventDeclaration<Fields, Schema<unknown, boolean>>;

/** Filter fields hold JSON scalars, which subscribers compare for equality. */
const scalarTypes = new Set(["string", "number", "integer", "boolean"]);
const isScalarSchema = (document: JsonObject): boolean => {
  const type = document.type;
  if (typeof type === "string") return scalarTypes.has(type);
  const choices = Array.isArray(document.enum)
    ? document.enum
    : "const" in document
      ? [document.const]
      : undefined;
  return (
    choices !== undefined &&
    choices.length > 0 &&
    choices.every((value) => ["string", "number", "boolean"].includes(typeof value))
  );
};

/**
 * Declare an event. `filters` are scalar fields subscribers can narrow on, such as a repository;
 * every emitted occurrence supplies their values. `payload` describes each occurrence's data.
 */
export const event = <
  const F extends Fields = {},
  P extends Schema<unknown, boolean> = Schema<unknown>,
>(options: {
  readonly description: string;
  readonly filters?: F;
  readonly payload: P;
}): EventDeclaration<F, P> => {
  const filters = options.filters ?? ({} as F);
  const fieldDecoders = Object.fromEntries(
    Object.entries(filters).map(([key, field]) => [
      key,
      decoderOf(schemaArgument(field, `The event filter ${JSON.stringify(key)}`)),
    ]),
  );
  for (const [key, decoder] of Object.entries(fieldDecoders)) {
    const document = Effect.runSync(jsonSchemaDocument(decoder));
    if (!isScalarSchema(document))
      throw new TypeError(
        `The event filter ${JSON.stringify(key)} must be a string, number, boolean or literal`,
      );
  }
  return {
    [Native]: {
      description: options.description,
      filters: fieldDecoders,
      payload: decoderOf(schemaArgument(options.payload, "The event payload")),
    },
    description: options.description,
    filters,
    payload: options.payload,
  };
};

/** The native declaration retained by an author event. */
export const nativeEvent = (declaration: unknown): AppEvent | undefined =>
  typeof declaration === "object" && declaration !== null && Native in declaration
    ? (declaration as AnyEventDeclaration)[Native]
    : undefined;

/** JSON Schema for each declared event, as the host reads it from requirements. */
export const declaredEvents = (events: Readonly<Record<string, AppEvent>>) =>
  Effect.forEach(Object.entries(events), ([name, declared]) =>
    Effect.gen(function* () {
      const filters = yield* jsonSchemaDocument(EffectSchema.Struct(declared.filters));
      const payload = yield* jsonSchemaDocument(declared.payload);
      return [name, { description: declared.description, filters, payload }] as const;
    }),
  ).pipe(Effect.map((entries): DeclaredEvents => Object.fromEntries(entries)));

/** Emit options typed by the event's filters: required exactly when it declares some. */
type OptionsFor<F extends Fields> = keyof F extends never
  ? [options?: Omit<EmitOptions<never>, "filters">]
  : [options: EmitOptions<ObjectValue<F>> & { readonly filters: ObjectValue<F> }];

/** `ctx.events` in mutations and webhook handlers. */
export interface EventEmitter<Events extends Readonly<Record<string, AnyEventDeclaration>>> {
  /**
   * Record an occurrence. It is delivered only if this invocation succeeds. Invalid data, filters
   * or options throw here, before anything is recorded.
   */
  readonly emit: <Name extends keyof Events & string>(
    name: Name,
    data: Infer<Events[Name]["payload"]>,
    ...options: OptionsFor<Events[Name]["filters"]>
  ) => void;
}

/** One invocation's buffer. The handler reads `emitted` only after the invocation succeeds. */
export const makeEmitter = (input: {
  readonly events: Readonly<Record<string, AppEvent>>;
  /** Every account ID bound to this invocation. */
  readonly accounts: readonly string[];
  /** The webhook's source account, which an emit names by default. */
  readonly sourceAccount?: string;
  readonly emitted: EmittedEvent[];
}): EventEmitter<Readonly<Record<string, AnyEventDeclaration>>> => ({
  emit: (name, data, ...rest) => {
    const options: EmitOptions<unknown> = rest[0] ?? {};
    const declared = Object.hasOwn(input.events, name) ? input.events[name] : undefined;
    if (declared === undefined) throw new TypeError(`This app declares no event named "${name}"`);
    if (input.emitted.length >= defaultEventLimits.maxEventsPerInvocation)
      throw new RangeError(
        `An invocation can emit at most ${defaultEventLimits.maxEventsPerInvocation} events`,
      );
    const payload = EffectSchema.decodeUnknownSync(declared.payload)(data);
    const filters = EffectSchema.decodeUnknownSync(EffectSchema.Struct(declared.filters))(
      options.filters ?? {},
    );
    const account =
      options.account ??
      input.sourceAccount ??
      (input.accounts.length === 1 ? input.accounts[0] : undefined) ??
      null;
    if (account === null && input.accounts.length > 1)
      throw new TypeError(
        "This invocation has several accounts; name the one the event came from with { account }",
      );
    if (account !== null && !input.accounts.includes(account))
      throw new TypeError("The event's account is not one of this invocation's accounts");
    const occurredAt =
      options.occurredAt === undefined
        ? Date.now()
        : options.occurredAt instanceof Date
          ? options.occurredAt.getTime()
          : options.occurredAt;
    const occurrence = EffectSchema.decodeUnknownSync(EmittedEvent)({
      name: EffectSchema.decodeUnknownSync(EventName)(name),
      id: options.id ?? crypto.randomUUID(),
      occurredAt,
      data: payload,
      filters,
      account,
    });
    if (
      new TextEncoder().encode(JSON.stringify(occurrence.data)).byteLength >
      defaultEventLimits.maxDataBytes
    )
      throw new RangeError(
        `An event's data can be at most ${defaultEventLimits.maxDataBytes} bytes of JSON; send a summary and a tool to read the rest`,
      );
    input.emitted.push(occurrence);
  },
});
