/** Bounded public display data. Never return credentials, private references or raw responses. */
import { Schema } from "effect";

const label = Schema.NonEmptyString.check(Schema.isMaxLength(64));
const resetsAt = Schema.String.check(
  Schema.isMaxLength(35),
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u),
  Schema.makeFilter((value) => {
    const instant = Date.parse(value);
    if (!Number.isFinite(instant)) return false;
    const zone = value.match(/([+-])(\d{2}):(\d{2})$/);
    const offset =
      zone === null ? 0 : (zone[1] === "+" ? 1 : -1) * (Number(zone[2]) * 60 + Number(zone[3]));
    return new Date(instant + offset * 60_000).toISOString().slice(0, 19) === value.slice(0, 19);
  }),
);

/** Counts and text are bounded before data crosses the app boundary or enters storage. */
export const AccountStatus = Schema.Struct({
  badges: Schema.Array(
    Schema.Struct({
      label,
      tone: Schema.Literals(["neutral", "good", "warning", "bad"]),
    }),
  ).check(Schema.isMaxLength(8)),
  meters: Schema.Array(
    Schema.Struct({
      label,
      remaining: Schema.NullOr(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
      resetsAt: Schema.optionalKey(resetsAt),
      detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
    }),
  ).check(Schema.isMaxLength(4)),
  stats: Schema.Array(
    Schema.Struct({
      label,
      value: Schema.String.check(Schema.isMaxLength(128)),
    }),
  ).check(Schema.isMaxLength(8)),
});
export type AccountStatus = typeof AccountStatus.Type;
