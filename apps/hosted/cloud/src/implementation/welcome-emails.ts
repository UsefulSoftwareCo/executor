import { Effect, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  WelcomeEmailUnavailable,
  type SendWelcomeEmail,
  type UnsubscribeLinks,
} from "../contracts/email.ts";
import { welcomeEmailMessage } from "./email-messages.ts";

const Recipients = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    email: Schema.RedactedFromValue(Schema.String),
    name: Schema.RedactedFromValue(Schema.String),
  }),
);

/**
 * Claim before sending, with no transaction held over the provider call. Only new,
 * verified users are eligible. Concurrent runs cannot claim the same recipient.
 * Cloudflare has no send idempotency key: an ambiguous attempt is held for review,
 * never retried automatically. A crash after claiming can therefore miss a welcome.
 */
export const deliverWelcomeEmails = (
  send: SendWelcomeEmail,
  links: (id: string, email: string) => Effect.Effect<UnsubscribeLinks, WelcomeEmailUnavailable>,
  origin: string,
  user?: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const stale = yield* sql`
      update cloud_welcome_email set status = 'uncertain'
      where status = 'attempting' and attempted_at < now() - interval '30 minutes'
      returning user_id`;
    if (stale.length > 0)
      yield* Effect.logError("Welcome email attempts need delivery review", {
        count: stale.length,
      });

    let sent = 0;
    for (let index = 0; index < 20; index++) {
      const recipients = yield* sql`
        with candidate as (
          select delivery.user_id from cloud_welcome_email delivery
          join "user" recipient on recipient.id = delivery.user_id
          where delivery.status = 'pending' and recipient."emailVerified" = true
            and (${user ?? null}::text is null or delivery.user_id = ${user ?? null})
            and not exists (select 1 from cloud_email_preferences preferences
              where preferences.user_id = delivery.user_id and preferences.optional_emails_unsubscribed_at is not null)
          order by delivery.created_at, delivery.user_id
          for update of delivery skip locked limit 1
        ), claimed as (
          update cloud_welcome_email delivery
          set status = 'attempting', attempted_at = now()
          from candidate where delivery.user_id = candidate.user_id
          returning delivery.user_id
        )
        select recipient.id, recipient.email, recipient.name from claimed
        join "user" recipient on recipient.id = claimed.user_id`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Recipients)),
      );
      const recipient = recipients[0];
      if (recipient === undefined) break;
      const accepted = yield* send(
        welcomeEmailMessage(
          Redacted.value(recipient.email),
          Redacted.value(recipient.name),
          yield* links(recipient.id, Redacted.value(recipient.email)),
          origin,
        ),
      ).pipe(
        Effect.timeout("15 seconds"),
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (accepted) {
        yield* sql`update cloud_welcome_email set status = 'sent', sent_at = now()
          where user_id = ${recipient.id} and status = 'attempting'`;
        sent += 1;
      } else {
        yield* sql`update cloud_welcome_email set status = 'uncertain'
          where user_id = ${recipient.id} and status = 'attempting'`;
        yield* Effect.logError("Welcome email attempt needs delivery review", {
          userId: recipient.id,
        });
      }
    }
    if (sent > 0) yield* Effect.logInfo("Welcome emails accepted by provider", { count: sent });
  }).pipe(
    Effect.mapError(() => new WelcomeEmailUnavailable()),
    Effect.withSpan("email.welcome.deliver"),
  );
