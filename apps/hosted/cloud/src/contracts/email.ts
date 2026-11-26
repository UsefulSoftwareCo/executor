import { Effect, Redacted, Schema } from "effect";

export interface AuthEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: Redacted.Redacted<string>;
  readonly html?: Redacted.Redacted<string>;
  readonly headers?: Redacted.Redacted<Readonly<Record<string, string>>>;
}
export class EmailDeliveryFailed extends Schema.TaggedError<EmailDeliveryFailed>()(
  "EmailDeliveryFailed",
  {},
) {}
export type SendAuthEmail = (email: AuthEmail) => Effect.Effect<void, EmailDeliveryFailed>;

export type SendWelcomeEmail = SendAuthEmail;

export class WelcomeEmailUnavailable extends Schema.TaggedError<WelcomeEmailUnavailable>()(
  "WelcomeEmailUnavailable",
  {},
) {}

export class InvalidUnsubscribeLink extends Schema.TaggedError<InvalidUnsubscribeLink>()(
  "InvalidUnsubscribeLink",
  {},
) {}

export interface UnsubscribeLinks {
  readonly browser: Redacted.Redacted<string>;
  readonly oneClick: Redacted.Redacted<string>;
}

export const unavailableAuthEmail: SendAuthEmail = () => Effect.fail(new EmailDeliveryFailed());
