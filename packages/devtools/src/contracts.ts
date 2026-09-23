/** Local-only dev tools protocol shared by the three product shells. */
import { Schema } from "effect";

/** A host advertises only the development capability it implements. */
export const DevtoolsState = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("operator"),
    host: Schema.Literals(["self-host", "cloud"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("pairing"),
    host: Schema.Literal("local"),
    paired: Schema.Boolean,
  }),
]);
/** A successful action changes the browser's HttpOnly session cookie. */
export const DevtoolsSuccess = Schema.Struct({ status: Schema.Literal(true) });

/** Verified display identity supplied by the host's existing session query. */
export interface OperatorIdentity {
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly role?: string | null | undefined;
  };
  readonly session?: { readonly impersonatedBy?: string | null | undefined } | undefined;
}
