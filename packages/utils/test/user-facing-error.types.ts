/** Compile-only proof that the factory preserves schemas, tags, and required recovery. */
import { Schema } from "effect";
import { UserFacingError } from "../src/user-facing-error.ts";

const Example = UserFacingError.define({
  tag: "Example",
  status: 422,
  fields: { reason: Schema.Literals(["missing", "invalid"]) },
  presentation: ({ reason }) => ({
    title: reason,
    description: "Settings could not be used.",
    recovery: { action: "Check settings.", instructions: "Inspect the configuration." },
  }),
});
const instance = new Example({ reason: "missing" });
const tag: "Example" = instance._tag;
const reason: "missing" | "invalid" = instance.reason;
const wireMessage: string = Schema.encodeSync(Example)(instance).message;
const displayed: UserFacingError = instance;
const decoded: typeof Example.Type = Schema.decodeUnknownSync(Example)({
  _tag: "Example",
  reason: "missing",
  message: "Settings could not be used.",
});

// @ts-expect-error Required payload must not disappear in the factory.
new Example();
// @ts-expect-error The constructor preserves the literal reason union.
new Example({ reason: "other" });
// @ts-expect-error Messages are owned by the error definition, not constructor callers.
new Example({ reason: "missing", message: "replacement" });
// @ts-expect-error User-facing errors must declare recovery instructions.
UserFacingError.define({ tag: "Incomplete", status: 500, title: "Failed", description: "Failed." });
// @ts-expect-error Payload fields cannot replace the error-owned presentation.
UserFacingError.define({
  tag: "Collision",
  status: 500,
  fields: { title: Schema.String },
  title: "Failed",
  description: "Failed.",
  recovery: { action: "Retry.", instructions: "Retry." },
});
