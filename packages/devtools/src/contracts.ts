/** Local-only dev tools protocol shared by the three product shells. */
import { Schema } from "effect";

/** Test membership roles supported by hosted products. Local has no account roles. */
export const TestRole = Schema.Literals(["member", "admin", "owner"]);
/** A selectable person is identified by user ID, independently of their current role. */
export const DevtoolsAccount = Schema.Struct({
  id: Schema.NonEmptyString,
  role: TestRole,
  name: Schema.String,
  email: Schema.String,
});
/** The viewed organization determines membership; a login-wide active organization does not. */
export const DevtoolsOrganization = Schema.Struct({
  id: Schema.NonEmptyString,
  slug: Schema.NonEmptyString,
  name: Schema.String,
});
/** A host advertises only the development capability it implements. */
export const DevtoolsState = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("accounts"),
    host: Schema.Literals(["self-host", "cloud"]),
    organization: DevtoolsOrganization,
    accounts: Schema.Array(DevtoolsAccount),
    selected: Schema.NullOr(Schema.String),
    impersonating: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("pairing"),
    host: Schema.Literal("local"),
    paired: Schema.Boolean,
  }),
]);
/** The server verifies that this user still belongs to the explicitly selected local organization. */
export const TestSignIn = Schema.Struct({
  organization: Schema.NonEmptyString,
  userId: Schema.NonEmptyString,
});
/** A successful action changes the browser's HttpOnly session cookie. */
export const DevtoolsSuccess = Schema.Struct({ status: Schema.Literal(true) });
