/** Client primitives use Effect Atom while authors keep ordinary schemas and Promise transports. */
import { Effect, Schema as EffectSchema, Stream } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { AppQueryFailed, type OperationReference, type QueryTransport } from "../contracts/live.ts";
import { JsonValue } from "../contracts/schema.ts";
import { StorageName } from "../contracts/storage.ts";
import type { Operation } from "./operations.ts";
import { decoderOf, type Schema } from "./schema.ts";

type InputOf<OperationType> =
  OperationType extends Operation<infer Input, infer _Output, infer _Kind, infer _Context>
    ? Input
    : never;
type OutputOf<OperationType> =
  OperationType extends Operation<infer _Input, infer Output, infer _Kind, infer _Context>
    ? Output
    : never;
/** Make a query reference using a type-only server import. No handler is passed or bundled. */
export const queryReference = <Query>(
  name: Query extends Operation<infer _Input, infer _Output, "query", infer _Context>
    ? string
    : never,
): OperationReference<InputOf<Query>, OutputOf<Query>, "query"> => ({
  name: EffectSchema.decodeUnknownSync(StorageName)(name),
  kind: "query",
});
/** Make a mutation reference using a type-only server import. */
export const mutationReference = <Mutation>(
  name: Mutation extends Operation<infer _Input, infer _Output, "mutation", infer _Context>
    ? string
    : never,
): OperationReference<InputOf<Mutation>, OutputOf<Mutation>, "mutation"> => ({
  name: EffectSchema.decodeUnknownSync(StorageName)(name),
  kind: "mutation",
});

/** Subscribe for the atom's mounted lifetime and parse every result using a shared output schema.
 * The host supplies routing, authentication and reconnection behavior through transport.
 */
export const liveQueryAtom = <Input, Output>(
  reference: OperationReference<Input, Output, "query">,
  input: NoInfer<Input>,
  options: {
    readonly output: Schema<NoInfer<Output>, boolean>;
    readonly transport: QueryTransport;
  },
) =>
  Atom.make(
    Stream.unwrap(
      Effect.gen(function* () {
        const parsed = yield* EffectSchema.decodeUnknownEffect(JsonValue)(input).pipe(
          Effect.mapError(() => new AppQueryFailed()),
        );
        const iterable = yield* Effect.tryPromise({
          try: () => options.transport.subscribe({ name: reference.name, input: parsed }),
          catch: () => new AppQueryFailed(),
        });
        return Stream.fromAsyncIterable(iterable, () => new AppQueryFailed()).pipe(
          Stream.mapEffect((value) =>
            EffectSchema.decodeUnknownEffect(decoderOf(options.output))(value).pipe(
              Effect.mapError(() => new AppQueryFailed()),
            ),
          ),
        );
      }),
    ),
  );
