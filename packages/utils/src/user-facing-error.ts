import { Schema, SchemaGetter, type Cause } from "effect";
import "effect/http-api";
import { MessageField } from "./api-error.ts";
import { RecordedMessage } from "./recorded-message.ts";

export interface ErrorPresentation {
  readonly title: string;
  readonly description: string;
  readonly recovery: {
    readonly action: string;
    readonly instructions: string;
  };
  readonly retryable?: boolean;
  readonly agentFixable?: boolean;
  readonly detail?: { readonly label: string; readonly value: string };
  readonly report?: string;
}

type PresentationProperties = Required<Omit<ErrorPresentation, "detail" | "report">> & {
  readonly detail: ErrorPresentation["detail"];
  readonly report: ErrorPresentation["report"];
  readonly code: string;
  readonly fixPrompt: string;
};

const TypeId = Symbol.for("@executor-js/utils/UserFacingError");

export interface UserFacingError extends Cause.YieldableError, PresentationProperties {
  readonly _tag: string;
}

type Header<Tag extends string> = {
  readonly tag: Tag;
  readonly status: number;
};
type Definition<Tag extends string, Fields extends Schema.Struct.Fields> = Header<Tag> & {
  readonly fields: Fields & {
    readonly [Key in keyof PresentationProperties | "_tag" | "message"]?: never;
  };
  readonly recorded?: (fields: Schema.Struct.Type<Fields>) => string;
} & (
    | ErrorPresentation
    | {
        readonly presentation: (fields: Schema.Struct.Type<Fields>) => ErrorPresentation;
      }
  );
const Recovery = Schema.Struct({ action: Schema.String, instructions: Schema.String });
const RecoveryField = Recovery.pipe(
  Schema.decodeTo(Schema.optionalKey(Recovery), {
    decode: SchemaGetter.omit(),
    encode: SchemaGetter.passthrough(),
  }),
);
type DerivedFields = {
  readonly message: typeof MessageField;
  readonly recovery: typeof RecoveryField;
};
type ErrorFields<Tag extends string, Fields extends Schema.Struct.Fields> = Omit<
  Schema.TaggedStruct<Tag, Fields & DerivedFields>,
  "~type.make.in"
> & {
  readonly "~type.make.in": Schema.TaggedStruct<Tag, Fields>["~type.make.in"];
};
type ErrorClass<Tag extends string, Fields extends Schema.Struct.Fields> = Schema.Class<
  Schema.Struct.Type<Fields> & UserFacingError & { readonly _tag: Tag },
  ErrorFields<Tag, Fields>,
  UserFacingError
>;

function withFields<const Tag extends string, const Fields extends Schema.Struct.Fields>(
  definition: Definition<Tag, Fields>,
): ErrorClass<Tag, Fields> {
  type Self = Schema.Struct.Type<Fields> & UserFacingError;
  const fields: Fields = definition.fields;
  const documentation =
    "presentation" in definition
      ? {}
      : { description: `${definition.description} ${definition.recovery.action}` };
  const DefinedError = Schema.Error<UserFacingError & { readonly _tag: Tag }>(definition.tag)(
    Schema.TaggedStruct(definition.tag, {
      ...fields,
      message: MessageField,
      recovery: RecoveryField,
    }).annotate(documentation),
    {
      httpApiStatus: definition.status,
      ...documentation,
    },
  );
  const presentation = (error: Self): ErrorPresentation =>
    "presentation" in definition ? definition.presentation(error) : definition;
  const properties = {
    code: {
      get() {
        return definition.tag;
      },
    },
    title: {
      get(this: Self) {
        return presentation(this).title;
      },
    },
    description: {
      get(this: Self) {
        return presentation(this).description;
      },
    },
    recovery: {
      get(this: Self) {
        return presentation(this).recovery;
      },
    },
    retryable: {
      get(this: Self) {
        return presentation(this).retryable ?? false;
      },
    },
    agentFixable: {
      get(this: Self) {
        return presentation(this).agentFixable ?? true;
      },
    },
    detail: {
      get(this: Self) {
        return presentation(this).detail;
      },
    },
    report: {
      get(this: Self) {
        return presentation(this).report;
      },
    },
    fixPrompt: {
      get(this: Self) {
        const details = presentation(this);
        return [
          "Diagnose and fix this problem in Executor. Use the current app context where relevant.",
          `Error: ${details.title}\nError code: ${this.code}\nKnown cause: ${details.description}${details.detail === undefined ? "" : `\n${details.detail.label}: ${details.detail.value}`}`,
          `Investigation and recovery:\n${details.recovery.instructions}`,
          "Make the smallest justified fix. Preserve existing account selections and credentials. Do not expose secrets in code, logs, or your reply. If you need a user action or access you do not have, explain the exact next step.",
          "Verify the failed operation after the fix and explain what changed. If you cannot verify it, state what remains blocked.",
        ].join("\n\n");
      },
    },
  } satisfies {
    readonly [Key in keyof PresentationProperties]: {
      get(this: Self): PresentationProperties[Key];
    };
  };
  const fixed = "presentation" in definition ? undefined : definition.description;
  const recorded = definition.recorded ?? (fixed === undefined ? undefined : () => fixed);
  Object.defineProperties(DefinedError.prototype, {
    ...properties,
    [TypeId]: { value: TypeId },
    message: {
      get(this: Self) {
        return presentation(this).description;
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
  definition: Header<Tag> & ErrorPresentation,
): ErrorClass<Tag, {}>;
function define<const Tag extends string, const Fields extends Schema.Struct.Fields>(
  definition: Definition<Tag, Fields>,
): ErrorClass<Tag, Fields>;
function define<Tag extends string, Fields extends Schema.Struct.Fields>(
  definition: (Header<Tag> & ErrorPresentation) | Definition<Tag, Fields>,
) {
  return "fields" in definition
    ? withFields(definition)
    : withFields({ ...definition, fields: {} });
}

const is = (value: unknown): value is UserFacingError =>
  typeof value === "object" && value !== null && TypeId in value;

export const UserFacingError = { define, is };

export const UnexpectedError = define({
  tag: "UnexpectedError",
  status: 500,
  title: "Action unavailable",
  description: "Executor could not complete this action because of an unexpected error.",
  recovery: {
    action: "Try again. If this continues, copy the fix prompt into your agent to investigate.",
    instructions:
      "Reproduce the failed operation and inspect safe diagnostics to identify its cause. This error category does not establish a specific cause. Distinguish app configuration, service availability, and Executor defects before choosing a fix.",
  },
  retryable: true,
});
