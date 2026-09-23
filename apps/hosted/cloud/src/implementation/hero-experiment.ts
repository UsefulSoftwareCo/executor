/** PostHog owns allocation. The host only maps its result to pre-rendered HTML. */
import { Effect, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import {
  heroCookieName,
  heroVisitorCookie,
  heroPreviewCookie,
  heroDocument,
  heroExperiment,
  heroVariants,
  HeroFlagValue,
  readHeroVisitor,
} from "@executor-js/marketing/experiments";

const Flags = Schema.Struct({
  flags: Schema.Record(Schema.String, Schema.Unknown),
  errorsWhileComputingFlags: Schema.Boolean,
  quotaLimited: Schema.optional(Schema.Array(Schema.String)),
});
const Flag = Schema.Struct({ enabled: Schema.Boolean, variant: Schema.optional(Schema.String) });

/** Evaluate using the public project token; no management credential enters the Worker. */
export const evaluateHeroFlag = (
  settings: { readonly token: string; readonly host: string },
  visitor: string,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(`${settings.host}/flags?v=2`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ api_key: settings.token, distinct_id: visitor }),
      ),
    );
    if (response.status !== 200) return yield* Effect.fail("Flag evaluation unavailable");
    const result = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Flags)));
    if (result.errorsWhileComputingFlags || result.quotaLimited?.includes("feature_flags"))
      return yield* Effect.fail("Flag evaluation incomplete");
    const value = result.flags[heroExperiment.id];
    if (value === undefined) return undefined;
    const flag = yield* Schema.decodeUnknownEffect(Flag)(value);
    if (!flag.enabled) return undefined;
    return yield* Schema.decodeUnknownEffect(HeroFlagValue)(flag.variant);
  }).pipe(
    Effect.timeout("1 second"),
    Effect.catch(() =>
      Effect.logWarning("Hero flag unavailable; serving untracked control").pipe(
        Effect.as(undefined),
      ),
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.scoped,
  );

/** Evaluation is injected by the host; an unconfigured local build serves the control. */
export type HeroFlagEvaluator = (visitor: string) => Effect.Effect<HeroFlagValue | undefined>;

/** Bots and previews do not evaluate flags or join the experiment. */
export const experimentHomepage = <E, R>(
  document: (entry: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  evaluate: HeroFlagEvaluator,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
    const url = new URL(web.url);
    const attributes = {
      path: "/",
      sameSite: "lax",
      secure: url.protocol === "https:",
      httpOnly: false,
    } as const;
    const preview = heroVariants.find((variant) => variant.id === url.searchParams.get("hero"));
    if (url.searchParams.has("hero")) {
      if (preview === undefined)
        return HttpServerResponse.text("Unknown hero preview.", { status: 400 });
      return yield* (yield* document(heroDocument(preview))).pipe(
        HttpServerResponse.setHeader("x-robots-tag", "noindex"),
        HttpServerResponse.setCookie(heroPreviewCookie, "1", attributes),
        Effect.orDie,
      );
    }
    if (/bot|crawler|spider|preview/i.test(request.headers["user-agent"] ?? ""))
      return yield* document("/index.html");
    const visitor = readHeroVisitor(request.headers.cookie ?? "") ?? crypto.randomUUID();
    const flag = yield* evaluate(visitor);
    const variant = heroVariants.find((value) => value.flag === flag);
    const response = yield* document(variant === undefined ? "/index.html" : heroDocument(variant));
    if (response.status !== 200) return response;
    const identified = yield* response.pipe(
      HttpServerResponse.setCookie(heroVisitorCookie, visitor, {
        ...attributes,
        maxAge: `${heroExperiment.cookieDays} days`,
      }),
      Effect.orDie,
      Effect.flatMap(HttpServerResponse.expireCookie(heroPreviewCookie, attributes)),
      Effect.orDie,
    );
    return yield* (
      flag === undefined
        ? identified.pipe(HttpServerResponse.expireCookie(heroCookieName, attributes))
        : identified.pipe(
            HttpServerResponse.setCookie(
              heroCookieName,
              JSON.stringify({ experiment: heroExperiment.id, visitor, variant: flag }),
              { ...attributes, maxAge: `${heroExperiment.cookieDays} days` },
            ),
          )
    ).pipe(Effect.orDie);
  });

/** Prevent a later user on a shared browser from inheriting an identified anonymous ID. */
export const clearHeroIdentityOnSignOut = (response: HttpServerResponse.HttpServerResponse) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (
      request.method !== "POST" ||
      new URL(request.url, "http://localhost").pathname !== "/api/auth/sign-out" ||
      response.status < 200 ||
      response.status >= 300
    )
      return response;
    let cleared = response;
    for (const name of [heroVisitorCookie, heroCookieName, heroPreviewCookie])
      cleared = yield* cleared.pipe(
        HttpServerResponse.expireCookie(name, { path: "/" }),
        Effect.orDie,
      );
    return cleared;
  });
