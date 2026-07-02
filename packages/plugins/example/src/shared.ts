// ---------------------------------------------------------------------------
// @executor-js/plugin-example/shared
//
// Schemas and the HttpApiGroup definition shared between the server and
// client halves. Both `./server` and `./client` import from here so the
// frontend's typed reactive client and the backend's handlers see the
// exact same payload/response/error contracts.
//
// No React or Node imports here — server and client both import this.
// ---------------------------------------------------------------------------

import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

export const Greeting = Schema.Struct({
  message: Schema.String,
  count: Schema.Number,
});
export type Greeting = typeof Greeting.Type;

export const ExampleApi = HttpApiGroup.make("example").add(
  HttpApiEndpoint.post("greet", "/greet", {
    payload: Schema.Struct({ name: Schema.String }),
    success: Greeting,
  }),
);
