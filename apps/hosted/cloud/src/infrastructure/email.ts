/** Cloudflare owns the sending domain and the Worker's native email binding. */
import * as Cloudflare from "alchemy/Cloudflare";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { retain } from "alchemy/RemovalPolicy";
import { RuntimeContext } from "alchemy";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { cloudEmulators } from "./emulators.ts";
import {
  EmailDeliveryFailed,
  type SendAuthEmail,
  type SendWelcomeEmail,
} from "../contracts/email.ts";

const emailDomain = Config.String("AUTH_EMAIL_DOMAIN").pipe(
  Config.withDefault("executor.sh"),
  Effect.flatMap(
    Schema.decodeUnknownEffect(
      Schema.String.check(
        Schema.makeFilter(
          (value) =>
            value.length <= 253 &&
            value.split(".").length >= 2 &&
            value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
          { message: "AUTH_EMAIL_DOMAIN must be a lowercase DNS domain" },
        ),
      ),
    ),
  ),
);

/** Deploy-only provisioning; local cloud development never changes email DNS. */
export const authEmailInfrastructure = Effect.gen(function* () {
  if ((yield* AlchemyContext).dev) return;
  // Existing sender domains are onboarded separately after reviewing shared DNS.
  if (!(yield* Config.Boolean("AUTH_EMAIL_PROVISION_SUBDOMAIN").pipe(Config.withDefault(false))))
    return;
  const domain = yield* emailDomain;
  const zoneId = yield* Config.String("CLOUDFLARE_ZONE_ID");
  yield* Cloudflare.Email.SendingSubdomain("AuthEmailDomain", { zoneId, name: domain }).pipe(
    retain(),
  );
});

/** Bind once in the HTTP Worker. Alchemy dev captures mail beneath .alchemy/local/email. */
export const cloudEmail = Effect.gen(function* () {
  const from = `no-reply@${yield* emailDomain}`;
  const founder = "rhys@executor.sh";
  const emulators = yield* cloudEmulators;
  if (Option.isSome(emulators)) {
    const { mail } = Redacted.value(emulators.value);
    const sender =
      (address: string): SendAuthEmail =>
      (email) =>
        Effect.scoped(
          Effect.gen(function* () {
            const http = yield* HttpClient.HttpClient;
            const request = yield* HttpClientRequest.post(`${mail.baseUrl}/emails`, {
              headers: { authorization: `Bearer ${mail.token}` },
            }).pipe(
              HttpClientRequest.bodyJson({
                from: address,
                ...(address === founder ? { reply_to: founder } : {}),
                ...(email.headers === undefined ? {} : { headers: Redacted.value(email.headers) }),
                to: email.to,
                subject: email.subject,
                text: Redacted.value(email.text),
                ...(email.html === undefined ? {} : { html: Redacted.value(email.html) }),
              }),
            );
            const response = yield* http.execute(request);
            yield* response.text;
            if (response.status < 200 || response.status >= 300)
              return yield* new EmailDeliveryFailed();
          }),
        ).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.mapError(() => new EmailDeliveryFailed()),
        );
    return { send: sender(from), welcome: sender(founder) };
  }

  const binding = yield* Cloudflare.Email.SendEmail("AuthEmail", {
    allowedSenderAddresses: [from, founder],
  });
  const client = yield* Cloudflare.Email.Send(binding);
  // The native binding is environment-owned, not a request-owned socket. Capture
  // its runtime context so Better Auth's Promise callbacks can execute the Effect.
  const runtime = yield* Cloudflare.Worker;
  const send: SendAuthEmail = (email) =>
    Effect.suspend(() =>
      client.send({
        from: { name: "Executor", email: from },
        to: email.to,
        subject: email.subject,
        text: Redacted.value(email.text),
        ...(email.html === undefined ? {} : { html: Redacted.value(email.html) }),
        ...(email.headers === undefined ? {} : { headers: Redacted.value(email.headers) }),
      }),
    ).pipe(
      Effect.provideService(RuntimeContext, runtime),
      Effect.mapError(() => new EmailDeliveryFailed()),
      Effect.asVoid,
    );
  const welcome: SendWelcomeEmail = (email) =>
    Effect.suspend(() =>
      client.send({
        from: { name: "Rhys at Executor", email: founder },
        replyTo: founder,
        to: email.to,
        subject: email.subject,
        text: Redacted.value(email.text),
        ...(email.html === undefined ? {} : { html: Redacted.value(email.html) }),
        ...(email.headers === undefined ? {} : { headers: Redacted.value(email.headers) }),
      }),
    ).pipe(
      Effect.provideService(RuntimeContext, runtime),
      Effect.mapError(() => new EmailDeliveryFailed()),
      Effect.asVoid,
    );
  return { send, welcome };
}).pipe(Effect.provide(Cloudflare.Email.SendBinding));
