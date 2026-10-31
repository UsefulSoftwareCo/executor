/** Display data shares the existing health JSON; older servers decode its identity fields only. */
import { Effect, Option, Schema } from "effect";
import { AccountInfo, AccountStatus } from "apps/contracts";
import { StorageError } from "../contracts/shared.ts";

const Record = Schema.Struct({ displayStatus: Schema.optionalKey(AccountStatus) });
export const recordedDisplayStatus = (info: unknown) =>
  Schema.decodeUnknownOption(Record)(info).pipe(
    Option.flatMap((record) => Option.fromNullishOr(record.displayStatus)),
    Option.getOrUndefined,
  );

export const accountCheckRecord = (
  previous: { readonly info: unknown; readonly infoCheckedAt: Date | null } | null,
  info: AccountInfo | undefined,
  status: AccountStatus | undefined,
  checkedAt: Date,
) =>
  Effect.gen(function* () {
    const retained =
      previous?.info == null
        ? undefined
        : Option.getOrUndefined(Schema.decodeUnknownOption(AccountInfo)(previous.info));
    const identity = info ?? retained;
    const display =
      status === undefined
        ? undefined
        : yield* Schema.encodeEffect(AccountStatus)(status).pipe(
            Effect.mapError(() => new StorageError()),
          );
    return {
      info:
        identity === undefined && display === undefined
          ? null
          : { ...identity, ...(display === undefined ? {} : { displayStatus: display }) },
      infoCheckedAt: info === undefined ? (previous?.infoCheckedAt ?? null) : checkedAt,
    };
  });
