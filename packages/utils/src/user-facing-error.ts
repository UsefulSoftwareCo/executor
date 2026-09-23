import { Schema, type Cause } from "effect";
import "effect/unstable/httpapi";

/** Curated explanation and recovery. Never include raw diagnostics, credentials, or form values. */
export interface ErrorPresentation {
  readonly title: string;
  readonly description: string;
  readonly recovery: {
    readonly action: string;
    readonly instructions: string;
  };
  /** Repeating the failed operation can help. Configuration changes are not retries. */
  readonly retryable?: boolean;
}

type PresentationProperties = Required<ErrorPresentation> & {
  readonly code: string;
  readonly fixPrompt: string;
};

/** A yieldable error that owns its safe user explanation and agent recovery task. */
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
} & (
    | ErrorPresentation
    | {
        readonly presentation: (fields: Schema.Struct.Type<Fields>) => ErrorPresentation;
      }
  );
type ErrorClass<Tag extends string, Fields extends Schema.Struct.Fields> = Schema.Class<
  Schema.Struct.Type<Fields> & UserFacingError & { readonly _tag: Tag },
  Schema.TaggedStruct<Tag, Fields>,
  UserFacingError
>;

function withFields<const Tag extends string, const Fields extends Schema.Struct.Fields>(
  definition: Definition<Tag, Fields>,
): ErrorClass<Tag, Fields> {
  type Self = Schema.Struct.Type<Fields> & UserFacingError;
  const fields: Fields = definition.fields;
  const DefinedError = Schema.TaggedError<UserFacingError & { readonly _tag: Tag }>()(
    definition.tag,
    fields,
    {
      httpApiStatus: definition.status,
      ...("presentation" in definition ? {} : { description: definition.description }),
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
    fixPrompt: {
      get(this: Self) {
        const details = presentation(this);
        return [
          "Diagnose and fix this problem in Executor. Use the current app context where relevant.",
          `Error: ${details.title}\nError code: ${this.code}\nKnown cause: ${details.description}`,
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
  Object.defineProperties(DefinedError.prototype, {
    ...properties,
    message: {
      get(this: Self) {
        return presentation(this).description;
      },
    },
  });
  // SAFETY: TaggedError constructs and decodes the declared fields and literal tag.
  // The complete, type-checked descriptor set above supplies the presentation on
  // that same constructor before it escapes. This narrows its generic Self type;
  // it does not assert the type of unparsed data or change the schema's payload.
  return DefinedError as ErrorClass<Tag, Fields>;
}

/** Define a schema-backed error with no payload. Its tag becomes its public error code. */
function define<const Tag extends string>(
  definition: Header<Tag> & ErrorPresentation,
): ErrorClass<Tag, {}>;
/** Define a schema-backed error whose safe presentation can depend on its parsed fields. */
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

/** Define the schema, error constructor, user copy, and agent recovery together. */
export const UserFacingError = { define };

/** Defects get a safe explanation without exposing an arbitrary cause. */
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
