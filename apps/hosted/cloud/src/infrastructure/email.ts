/** Cloudflare owns the sending domain and the Worker's native email binding. */
import * as Cloudflare from "alchemy/Cloudflare";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { retain } from "alchemy/RemovalPolicy";
import { Random, RuntimeContext } from "alchemy";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { cloudEmulators } from "./emulators.ts";
import { testStage } from "./stage.ts";
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
  if ((yield* AlchemyContext).dev || Option.isSome(yield* testStage)) return;
  // Existing sender domains are onboarded separately after reviewing shared DNS.
  if (!(yield* Config.Boolean("AUTH_EMAIL_PROVISION_SUBDOMAIN").pipe(Config.withDefault(false))))
    return;
  const domain = yield* emailDomain;
  const zoneId = yield* Config.String("CLOUDFLARE_ZONE_ID");
  yield* Cloudflare.Email.SendingSubdomain("AuthEmailDomain", { zoneId, name: domain }).pipe(
    retain(),
  );
});

/**
 * Test stages capture every message in a private emulator, including queued welcome mail.
 * Never acquire a native sending binding for a test stage. Local Alchemy dev also captures
 * its native binding; production keeps Cloudflare delivery.
 */
export const cloudEmail = Effect.gen(function* () {
  const from = `no-reply@${yield* emailDomain}`;
  const founder = "rhys@executor.sh";
  // Better Auth starts new Effect fibers. Preserve the environment that owns resource outputs.
  const runtime = yield* Cloudflare.Worker;
  const environment = yield* Cloudflare.WorkerEnvironment;
  const emulators = yield* cloudEmulators;
  const stage = yield* testStage;
  const capture = Option.isSome(emulators)
    ? Effect.succeed(Redacted.make(Redacted.value(emulators.value).mail))
    : Option.isSome(stage)
      ? yield* Effect.gen(function* () {
          // Like the billing emulator, a private instance is created lazily. Its random path
          // is a capability: retain it in Alchemy state and never put it in logs or outputs.
          const instance = yield* Random("MailInstance", { bytes: 12 });
          const secret = yield* Random("MailSecret");
          return Effect.all([yield* instance.text, yield* secret.text]).pipe(
            Effect.map(([id, token]) =>
              Redacted.make({
                baseUrl: `https://emulators.dev/resend/executor-next-${Redacted.value(id)}`,
                token: `re_${Redacted.value(token)}`,
              }),
            ),
          );
        })
      : undefined;
  if (capture !== undefined) {
    const sender =
      (address: string): SendAuthEmail =>
      (email) =>
        Effect.scoped(
          Effect.gen(function* () {
            const mail = Redacted.value(yield* capture);
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
          Effect.provideService(Cloudflare.WorkerEnvironment, environment),
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
