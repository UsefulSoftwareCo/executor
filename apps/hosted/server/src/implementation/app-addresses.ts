/** Address construction and parsing share one configured suffix; forwarding headers never select an app. */
import { AppId, AppSlug, HttpUrl, type App } from "@executor-js/sdk/core";
import { UiFailed } from "apps/ui/contracts";
import { Effect, Option, Schema } from "effect";
import { AppUiAddressInvalid, AppUiHostnameLabel, type AppUiBaseUrl } from "../contracts/app-ui.ts";
import { OrganizationSlug } from "../contracts/organization.ts";

/** Hosted app.organization addresses resolve current names before authorizing immutable identities. */
export const appAddresses = (
  dashboardOrigin: string,
  baseUrl: AppUiBaseUrl | undefined,
  scheme: "nested" | "opaque" = "nested",
  embedded = false,
) => {
  const base = baseUrl === undefined ? undefined : new URL(baseUrl);
  const dashboardHost = new URL(dashboardOrigin).host;
  const origin = (app: Pick<App, "id" | "slug">, slug: OrganizationSlug) =>
    Effect.gen(function* () {
      if (base === undefined) return yield* new UiFailed({ reason: "unavailable" });
      const labels = yield* Schema.decodeUnknownEffect(Schema.Array(AppUiHostnameLabel))(
        scheme === "opaque" ? [] : [app.slug, slug],
      ).pipe(
        Effect.mapError(
          () =>
            new AppUiAddressInvalid({
              reason: app.slug.length > 63 || slug.length > 63 ? "too_long" : "invalid_slug",
            }),
        ),
      );
      const url = new URL(base);
      const hostname =
        scheme === "opaque"
          ? `a-${app.id.slice(4)}.${base.hostname}`
          : `${labels.join(".")}.${base.hostname}`;
      if (scheme === "opaque" && !/^app_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(app.id))
        return yield* new AppUiAddressInvalid({ reason: "invalid_slug" });
      url.hostname = hostname;
      if (url.host === dashboardHost)
        return yield* new AppUiAddressInvalid({ reason: "invalid_slug" });
      if (url.hostname !== hostname)
        return yield* new AppUiAddressInvalid({ reason: "invalid_slug" });
      if (url.hostname.length > 253) return yield* new AppUiAddressInvalid({ reason: "too_long" });
      return HttpUrl.make(url.origin);
    });
  type Host =
    | { readonly kind: "opaque"; readonly app: App["id"]; readonly origin: string }
    | {
        readonly kind: "nested";
        readonly find: { readonly slug: App["slug"] };
        readonly slug: OrganizationSlug;
        readonly origin: string;
      };
  const fromHost = (host: string | undefined): Option.Option<Host> => {
    if (base === undefined || host === undefined) return Option.none();
    const url = URL.parse(`${base.protocol}//${host}`);
    const suffix = `.${base.hostname}`;
    if (
      url === null ||
      url.host !== host.toLowerCase() ||
      url.port !== base.port ||
      !url.hostname.endsWith(suffix)
    )
      return Option.none();
    const labels = url.hostname.slice(0, -suffix.length).split(".");
    if (scheme === "opaque") {
      const match = /^a-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.exec(labels.join("."));
      return match === null || url.host === dashboardHost
        ? Option.none()
        : Option.some({
            kind: "opaque" as const,
            app: AppId.make(`app_${match[1]}`),
            origin: HttpUrl.make(url.origin),
          });
    }
    if (labels.length !== 2) return Option.none();
    return Option.flatMap(
      Schema.decodeUnknownOption(Schema.Array(AppUiHostnameLabel))(labels),
      ([app, slug]) => {
        return Schema.decodeUnknownOption(
          Schema.Struct({
            kind: Schema.Literal("nested"),
            find: Schema.Struct({ slug: AppSlug }),
            slug: OrganizationSlug,
            origin: HttpUrl,
          }),
        )({ kind: "nested", find: { slug: app }, slug, origin: url.origin });
      },
    );
  };
  return {
    dashboardOrigin,
    scheme,
    embedded,
    enabled: base !== undefined,
    origin,
    fromHost,
    ownsHost: (host: string | undefined) =>
      base !== undefined &&
      host !== undefined &&
      host.toLowerCase() !== dashboardHost &&
      (URL.parse(`${base.protocol}//${host}`)?.hostname.endsWith(`.${base.hostname}`) ?? false),
  };
};
