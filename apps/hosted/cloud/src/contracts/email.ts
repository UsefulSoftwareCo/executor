import { Effect, Redacted, Schema } from "effect";

/** Email payloads include login secrets and must never be logged. */
export interface AuthEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: Redacted.Redacted<string>;
  readonly html?: Redacted.Redacted<string>;
  /** Unsubscribe URLs carry bearer tokens and must not appear in logs. */
  readonly headers?: Redacted.Redacted<Readonly<Record<string, string>>>;
}
/** Safe delivery failure; provider responses and credentials remain private. */
export class EmailDeliveryFailed extends Schema.TaggedError<EmailDeliveryFailed>()(
  "EmailDeliveryFailed",
  {},
) {}
/** Provider boundary used by auth callbacks and isolated delivery tests. */
export type SendAuthEmail = (email: AuthEmail) => Effect.Effect<void, EmailDeliveryFailed>;

/** A background welcome uses the monitored founder address, independently of login mail. */
export type SendWelcomeEmail = SendAuthEmail;

/** Safe queue failure; SQL and recipient details must not enter logs. */
export class WelcomeEmailUnavailable extends Schema.TaggedError<WelcomeEmailUnavailable>()(
  "WelcomeEmailUnavailable",
  {},
) {}

/** A malformed, tampered, deleted-account or superseded-address unsubscribe link. */
export class InvalidUnsubscribeLink extends Schema.TaggedError<InvalidUnsubscribeLink>()(
  "InvalidUnsubscribeLink",
  {},
) {}

/** Signed links are valid only for this account, current address and deployment secret. */
export interface UnsubscribeLinks {
  readonly browser: Redacted.Redacted<string>;
  readonly oneClick: Redacted.Redacted<string>;
}

/** Migrations and MCP authentication cannot send email; accidental delivery fails closed. */
export const unavailableAuthEmail: SendAuthEmail = () => Effect.fail(new EmailDeliveryFailed());
