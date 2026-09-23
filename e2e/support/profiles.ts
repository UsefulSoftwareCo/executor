/** Profile setup through the public API. Each fixture retains the returned identity explicitly. */
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "./api.ts";

/** Account selections and revision returned by a real profile write. */
export const Profile = Schema.Struct({
  id: Schema.String,
  revision: Schema.Number,
  accounts: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  ),
});

/** Create one empty fixture profile, optionally supplying the SDK's explicit owner and subject. */
export const createProfile = (
  actor: Session,
  appPath: string,
  identity?: { readonly owner: string; readonly subject: string },
  headers?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const api = yield* Api;
    return yield* body(
      Profile,
      yield* api.request(
        actor,
        "POST",
        `${appPath}/profiles`,
        { ...identity, accounts: {}, idempotencyKey: randomUUID() },
        headers,
      ),
    );
  });

/** Read the exact fixture profile's revision before replacing its complete selection. */
export const selectProfileAccounts = (
  actor: Session,
  appPath: string,
  profile: string,
  accounts: typeof Profile.Type.accounts,
  headers?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const path = `${appPath}/profiles/${profile}`;
    const current = yield* body(
      Profile,
      yield* api.request(actor, "GET", path, undefined, headers),
    );
    return yield* api.request(
      actor,
      "PATCH",
      path,
      { expectedRevision: current.revision, accounts },
      headers,
    );
  });
