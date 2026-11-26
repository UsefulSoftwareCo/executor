import { Schema, SchemaGetter, type Cause } from "effect";
import "effect/http-api";
import { RecordedMessage } from "./recorded-message.ts";

export const MessageField = Schema.String.pipe(
  Schema.decodeTo(Schema.optionalKey(Schema.String), {
    decode: SchemaGetter.omit(),
    encode: SchemaGetter.passthrough(),
  }),
);

export interface ApiError extends Cause.YieldableError {
  readonly _tag: string;
}

type Header<Tag extends string> = {
  readonly tag: Tag;
  readonly status: number;
};
type Definition<Tag extends string, Fields extends Schema.Struct.Fields> = Header<Tag> & {
  readonly fields: Fields & { readonly [Key in "_tag" | "message"]?: never };
  readonly message: string | ((fields: Schema.Struct.Type<Fields>) => string);
  readonly recorded?: (fields: Schema.Struct.Type<Fields>) => string;
};
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
  const documentation = typeof message === "string" ? { description: message } : {};
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
  return DefinedError as unknown as ErrorClass<Tag, Fields>;
}

function define<const Tag extends string>(
  definition: Header<Tag> & { readonly message: string },
): ErrorClass<Tag, {}>;
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

export const ApiError = { define };
