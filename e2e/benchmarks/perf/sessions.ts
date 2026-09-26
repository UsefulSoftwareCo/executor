/** Synthetic sessions from a perf stage's loopback fixture process. */
import { Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import { FixtureActors, FixtureControl, fixtureRequest } from "../../sdk/fixtures.ts";
import type { StageControl } from "./stage.ts";

/** Same id and label return the same organization and identities with fresh one-hour sessions. */
export const fixtureActors = (control: StageControl, id: string, label: string) =>
  Effect.gen(function* () {
    const fixture = yield* Schema.decodeUnknownEffect(FixtureControl)(control.fixture);
    return yield* fixtureRequest(fixture, "/actors", { id, label }, "5 minutes").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(FixtureActors)),
    );
  });

/** Deterministic UUID-shaped idempotency key. */
export const stableUuid = (text: string) => {
  const hex = createHash("sha256").update(text).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
