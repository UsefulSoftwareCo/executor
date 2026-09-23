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
  Schema.check(Schema.isStartsWith("acc_"), Schema.isMinLength(5)),
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

/** Invalid input. Never includes supplied values, credentials or response bodies. */
export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {}) {
  override get message() {
    return "Value did not match the schema";
  }
}
