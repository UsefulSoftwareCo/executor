/** Runtime data schemas shared by the app framework. Author helpers live at the boundary. */
import { Schema } from "effect";

/** JSON values carried by remote protocols such as MCP. */
export const JsonValue = Schema.Json;
export type JsonValue = Schema.Json;

/** A JSON object, distinct from an authored value schema. */
export const JsonObject = Schema.Record(Schema.String, JsonValue);
export type JsonObject = typeof JsonObject.Type;

/** Stable saved account identity supplied by a host, unchanged across refreshes. */
export const AccountId = Schema.String.pipe(
  Schema.check(Schema.isStartingWith("acc_"), Schema.isMinLength(5)),
  Schema.brand("acc"),
);
/** Parsed saved account identity. */
export type AccountId = typeof AccountId.Type;

/** Absolute HTTP(S) URL; local HTTP hosts are supported. */
export const HttpUrl = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }),
);

/** One problem with a declaration: where in it, and what is wrong there. */
export const DeclarationIssue = Schema.Struct({
  path: Schema.Array(Schema.String),
  message: Schema.String,
});
export type DeclarationIssue = typeof DeclarationIssue.Type;

/**
 * An author's declaration, such as the options of `oauth2()`, did not match its schema. Unlike
 * {@link ValidationError} it names each failing path and problem, because the value is the
 * author's own source. Messages never include supplied values.
 */
export class DeclarationInvalid extends Schema.TaggedError<DeclarationInvalid>()(
  "DeclarationInvalid",
  { declaration: Schema.String, issues: Schema.Array(DeclarationIssue) },
) {
  override get message() {
    const problems = this.issues.map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
    );
    return `The ${this.declaration} declaration is invalid. ${problems.join("; ")}`;
  }
}

/** Invalid input. Never includes supplied values, credentials or response bodies. */
export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {}) {
  override get message() {
    return "Value did not match the schema";
  }
}
