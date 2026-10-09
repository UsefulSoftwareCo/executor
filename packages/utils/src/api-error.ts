import { Schema, SchemaGetter, type Cause } from "effect";
import "effect/http-api";
import { RecordedMessage } from "./recorded-message.ts";

/**
 * Encode the class's `message` getter as a required wire string. Decoding validates the field,
 * then omits it, so the class derives its own message from the parsed payload and a supplied
 * value never replaces it.
 */
export const MessageField = Schema.String.pipe(
  Schema.decodeTo(Schema.optionalKey(Schema.String), {
    decode: SchemaGetter.omit(),
    encode: SchemaGetter.passthrough(),
  }),
);

/** An expected API error whose response states its cause in a `message` derived from its fields. */
export interface ApiError extends Cause.YieldableError {
  readonly _tag: string;
}

type Header<Tag extends string> = {
  readonly tag: Tag;
  readonly status: number;
};
type Definition<Tag extends string, Fields extends Schema.Struct.Fields> = Header<Tag> & {
  readonly fields: Fields & { readonly [Key in "_tag" | "message"]?: never };
  /**
   * The cause, stated for API and agent callers. It is also the error's `message`, which traces
   * record, so it never includes credentials, upstream response text or submitted values.
   */
  readonly message: string | ((fields: Schema.Struct.Type<Fields>) => string);
  /**
   * What traces and error reports record beside the tag. A fixed `message` is recorded as is; a
   * message derived from fields is recorded only through this, from fixed text and closed fields,
   * never a value the caller chose, an app's text or a service's reply. Without it the error is
   * recorded by its tag alone.
   */
  readonly recorded?: (fields: Schema.Struct.Type<Fields>) => string;
};
// The derived message cannot be supplied by constructor callers.
type ErrorFields<Tag extends string, Fields extends Schema.Struct.Fields> = Omit<
  Schema.TaggedStruct<Tag, Fields & { readonly message: typeof MessageField }>,
  "~type.make.in"
> & {
  readonly "~type.make.in": Schema.TaggedStruct<Tag, Fields>["~type.make.in"];
};
type ErrorClass<Tag extends string, Fields extends Schema.Struct.Fields> = Schema.Class<
  Schema.Struct.Type<Fields> & ApiError & { readonly _tag: Tag },
  ErrorFields<Tag, Fields>,
  ApiError
>;

function withFields<const Tag extends string, const Fields extends Schema.Struct.Fields>(
  definition: Definition<Tag, Fields>,
): ErrorClass<Tag, Fields> {
  type Self = Schema.Struct.Type<Fields> & ApiError;
  const fields: Fields = definition.fields;
  const message = definition.message;
  // A static message also documents the encoded variant, as a schema description.
  const documentation = typeof message === "string" ? { description: message } : {};
  // TaggedError's mapFields drops struct annotations, so build the tagged Error from its parts.
  const DefinedError = Schema.Error<ApiError & { readonly _tag: Tag }>(definition.tag)(
    Schema.TaggedStruct(definition.tag, { ...fields, message: MessageField }).annotate(
      documentation,
    ),
    { httpApiStatus: definition.status, ...documentation },
  );
  const recorded = definition.recorded ?? (typeof message === "string" ? () => message : undefined);
  Object.defineProperties(DefinedError.prototype, {
    message: {
      get(this: Self) {
        return typeof message === "string" ? message : message(this);
      },
    },
    ...(recorded === undefined
      ? {}
      : {
          [RecordedMessage]: {
            get(this: Self) {
              return recorded(this);
            },
          },
        }),
  });
  // SAFETY: Schema.Error and TaggedStruct construct and decode the fields and literal tag. The
  // message getter is defined on that same constructor before it escapes. The message is derived,
  // omitted on decode and required on encode; narrowing the constructor input to the payload
  // fields prevents callers from replacing it.
  return DefinedError as unknown as ErrorClass<Tag, Fields>;
}

/** Define an error with no payload and a fixed message. Its tag is its public error code. */
function define<const Tag extends string>(
  definition: Header<Tag> & { readonly message: string },
): ErrorClass<Tag, {}>;
/** Define an error whose message can depend on its parsed fields. */
function define<const Tag extends string, const Fields extends Schema.Struct.Fields>(
  definition: Definition<Tag, Fields>,
): ErrorClass<Tag, Fields>;
function define<Tag extends string, Fields extends Schema.Struct.Fields>(
  definition: (Header<Tag> & { readonly message: string }) | Definition<Tag, Fields>,
) {
  return "fields" in definition
    ? withFields(definition)
    : withFields({ ...definition, fields: {} });
}

/**
 * Define the schema, constructor and API message of an expected error together. Errors that need
 * a user-facing title and recovery use `UserFacingError`, which carries the same message field.
 */
export const ApiError = { define };
