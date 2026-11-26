import { Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import { FixtureActors, FixtureControl, fixtureRequest } from "../../sdk/fixtures.ts";
import type { StageControl } from "./stage.ts";

export const fixtureActors = (control: StageControl, id: string, label: string) =>
  Effect.gen(function* () {
    const fixture = yield* Schema.decodeUnknownEffect(FixtureControl)(control.fixture);
    return yield* fixtureRequest(fixture, "/actors", { id, label }, "5 minutes").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(FixtureActors)),
    );
  });

export const stableUuid = (text: string) => {
  const hex = createHash("sha256").update(text).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
