/** Account check schemas retained by protocol 13 and 14. */
import { Schema } from "effect";
import { HttpUrl } from "../schema.ts";

const displayText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255));

export const AccountInfo = Schema.Struct({
  externalId: Schema.optionalKey(displayText),
  displayName: Schema.optionalKey(displayText),
  username: Schema.optionalKey(displayText),
  email: Schema.optionalKey(displayText),
  avatarUrl: Schema.optionalKey(HttpUrl),
  profileUrl: Schema.optionalKey(HttpUrl),
});

export const AccountCheckResult = Schema.Struct({
  accountInfo: Schema.optionalKey(AccountInfo),
});
