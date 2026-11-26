import { Schema } from "effect";

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
export const DevtoolsSuccess = Schema.Struct({ status: Schema.Literal(true) });

export interface OperatorIdentity {
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly role?: string | null | undefined;
  };
  readonly session?: { readonly impersonatedBy?: string | null | undefined } | undefined;
}
