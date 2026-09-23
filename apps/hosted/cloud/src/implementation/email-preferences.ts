import { ByteSize, Effect, Encoding, Option, Redacted, Schema } from "effect";
import { HttpIncomingMessage, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import {
  InvalidUnsubscribeLink,
  WelcomeEmailUnavailable,
  type UnsubscribeLinks,
} from "../contracts/email.ts";

const Token = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{43}$/));
const Recipient = Schema.Struct({
  id: Schema.NonEmptyString,
  email: Schema.RedactedFromValue(Schema.NonEmptyString),
});
const message = (id: string, email: string) =>
  new TextEncoder().encode(
    JSON.stringify(["executor.optional-email.unsubscribe.v1", id, email.trim().toLowerCase()]),
  );
const signingKey = (secret: Redacted.Redacted<string>) =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(Redacted.value(secret)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      ),
    catch: () => new WelcomeEmailUnavailable(),
  });

/** Separate browser confirmation and RFC 8058 URLs; no email address is exposed in either. */
export const unsubscribeLinks = (
  origin: string,
  secret: Redacted.Redacted<string>,
  id: string,
  email: string,
): Effect.Effect<UnsubscribeLinks, WelcomeEmailUnavailable> =>
  Effect.gen(function* () {
    const key = yield* signingKey(secret);
    const signature = yield* Effect.tryPromise({
      try: () => crypto.subtle.sign("HMAC", key, message(id, email)),
      catch: () => new WelcomeEmailUnavailable(),
    });
    const token = `${Encoding.encodeBase64Url(id)}.${Encoding.encodeBase64Url(new Uint8Array(signature))}`;
    return {
      browser: Redacted.make(`${origin}/email/unsubscribe#${token}`),
      oneClick: Redacted.make(`${origin}/api/email/unsubscribe?token=${token}`),
    };
  });

const unsubscribe = (token: string, secret: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownEffect(Token)(token).pipe(
      Effect.mapError(() => new InvalidUnsubscribeLink()),
    );
    const [encodedId, encodedSignature] = parsed.split(".");
    if (!encodedId || !encodedSignature) return yield* new InvalidUnsubscribeLink();
    const id = yield* Effect.fromResult(Encoding.decodeBase64UrlString(encodedId)).pipe(
      Effect.mapError(() => new InvalidUnsubscribeLink()),
    );
    const signature = yield* Effect.fromResult(Encoding.decodeBase64Url(encodedSignature)).pipe(
      Effect.mapError(() => new InvalidUnsubscribeLink()),
    );
    const sql = yield* SqlClient.SqlClient;
    const recipients = yield* sql`select id, email from "user" where id = ${id}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Recipient))),
      Effect.mapError(() => new WelcomeEmailUnavailable()),
    );
    const recipient = recipients[0];
    if (!recipient) return yield* new InvalidUnsubscribeLink();
    const key = yield* signingKey(secret);
    const valid = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.verify(
          "HMAC",
          key,
          Uint8Array.from(signature),
          message(recipient.id, Redacted.value(recipient.email)),
        ),
      catch: () => new InvalidUnsubscribeLink(),
    });
    if (!valid) return yield* new InvalidUnsubscribeLink();
    // The address guard also covers an email change racing verification. Repeat POSTs
    // preserve the original opt-out time and never enable optional mail again.
    const saved =
      yield* sql`insert into cloud_email_preferences (user_id, optional_emails_unsubscribed_at)
    select id, now() from "user" where id = ${recipient.id} and email = ${Redacted.value(recipient.email)}
    on conflict (user_id) do update set optional_emails_unsubscribed_at =
      coalesce(cloud_email_preferences.optional_emails_unsubscribed_at, excluded.optional_emails_unsubscribed_at)
    returning user_id`.pipe(Effect.mapError(() => new WelcomeEmailUnavailable()));
    if (saved.length === 0) return yield* new InvalidUnsubscribeLink();
  });

/** GET/HEAD never mutate: only a signed, explicit form POST can save an opt-out. */
export const unsubscribeHandler = (
  origin: string,
  secret: Effect.Effect<Redacted.Redacted<string>>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, origin);
    if (request.method === "GET" || request.method === "HEAD") {
      const token = Schema.decodeUnknownOption(Token)(url.searchParams.get("token"));
      return HttpServerResponse.redirect(
        `${origin}/email/unsubscribe${Option.isSome(token) ? `#${token.value}` : "?result=invalid"}`,
        { status: 303 },
      );
    }
    if (request.method !== "POST") return HttpServerResponse.empty({ status: 405 });
    const contentType = request.headers["content-type"] ?? "";
    if (
      !["application/x-www-form-urlencoded", "multipart/form-data"].includes(
        contentType.split(";")[0]?.trim() ?? "",
      )
    )
      return HttpServerResponse.empty({ status: 415 });
    const body = yield* request.arrayBuffer.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(2)),
      Effect.flatMap((bytes) =>
        Effect.tryPromise({
          try: () => new Response(bytes, { headers: { "content-type": contentType } }).formData(),
          catch: () => new InvalidUnsubscribeLink(),
        }),
      ),
      Effect.mapError(() => new InvalidUnsubscribeLink()),
    );
    if (body.get("List-Unsubscribe") !== "One-Click")
      return HttpServerResponse.empty({ status: 400 });
    const browser = body.has("token");
    const tokenField = browser ? body.get("token") : url.searchParams.get("token");
    const token = typeof tokenField === "string" ? tokenField : "";
    const response = yield* unsubscribe(token, yield* secret).pipe(
      Effect.as("unsubscribed" as const),
      Effect.catchTags({
        InvalidUnsubscribeLink: () => Effect.succeed("invalid" as const),
        WelcomeEmailUnavailable: () => Effect.succeed("error" as const),
      }),
    );
    return browser
      ? HttpServerResponse.redirect(
          `${origin}/email/unsubscribe?result=${response}${response === "error" ? `#${encodeURIComponent(token)}` : ""}`,
          { status: 303 },
        )
      : HttpServerResponse.empty({
          status: response === "unsubscribed" ? 200 : response === "invalid" ? 400 : 503,
        });
  }).pipe(
    Effect.catchTag("InvalidUnsubscribeLink", () =>
      Effect.succeed(HttpServerResponse.empty({ status: 400 })),
    ),
    Effect.map((response) =>
      response.pipe(
        HttpServerResponse.setHeader("cache-control", "no-store"),
        HttpServerResponse.setHeader("referrer-policy", "no-referrer"),
      ),
    ),
  );
