/** Native HTTP decoding contract. The public boundary adapts fetch Responses. */
import { type Effect, Schema } from "effect";

/** The response capability needed by the decoder, already adapted into Effect. */
export interface JsonResponse {
  readonly status: number;
  readonly json: () => Effect.Effect<unknown, ResponseDecodeError>;
}

/** A non-2xx response. Carries the status only, never the body. */
export class ResponseStatusError extends Schema.TaggedError<ResponseStatusError>()(
  "ResponseStatusError",
  { status: Schema.Number },
) {
  override get message() {
    return `Request failed with status ${this.status}`;
  }
}

/** Invalid JSON or a schema mismatch. Never includes the response body. */
export class ResponseDecodeError extends Schema.TaggedError<ResponseDecodeError>()(
  "ResponseDecodeError",
  {},
) {
  override get message() {
    return "Response body did not match the expected schema";
  }
}
