import { dashboardHttpClient } from "@executor-js/ui/contracts/http";
import {
  OrganizationAccess,
  OrganizationId,
  OrganizationReference,
} from "@executor-js/hosted-server/organization";
import { Effect, Equal, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Atom } from "effect/reactivity";

/** Keep this tab attached to the first verified ID even if its slug is renamed or reused. */
export const organizationTargetAtom = Atom.family((reference: OrganizationReference) =>
  Atom.make<OrganizationId | undefined>(undefined).pipe(
    Atom.serializable({
      key: `hosted:organization-target:${reference}`,
      schema: Schema.UndefinedOr(OrganizationId),
    }),
    Atom.keepAlive,
  ),
);
/**
 * Display snapshot keyed by verified identity; API middleware remains the authority for every action.
 * Every access read writes a fresh object, so compare structurally: an unchanged role must not
 * restart dependent queries that are already refreshing.
 */
export const organizationPresentationAtom = Atom.family((id: OrganizationId) =>
  Atom.make<OrganizationAccess | undefined>(undefined).pipe(
    Atom.withEquality(Equal.equals),
    Atom.serializable({
      key: `hosted:organization-presentation:${id}`,
      schema: Schema.UndefinedOr(OrganizationAccess),
    }),
    Atom.keepAlive,
  ),
);
/** Permission changes revalidate every reference observed by this tab. */
export const organizationAccessVersionAtom = Atom.make(0).pipe(Atom.keepAlive);
const decodeReference = (value: string) =>
  Option.liftThrowable(decodeURIComponent)(value).pipe(
    Option.flatMap(Schema.decodeUnknownOption(OrganizationReference)),
  );
/** First reads use the URL reference immediately; subsequent requests use its verified stable ID. */
export const organizationHttpClient = (get: Atom.AtomContext) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      client.pipe(
        HttpClient.mapRequest((request) => {
          const url = URL.parse(request.url, "https://executor.invalid");
          if (url === null || !url.pathname.startsWith("/api/organizations/")) return request;
          const segments = url.pathname.split("/");
          const encoded = segments[3];
          if (encoded === undefined) return request;
          const reference = decodeReference(encoded);
          if (Option.isNone(reference)) return request;
          const id = get.registry.get(organizationTargetAtom(reference.value));
          if (id === undefined) return request;
          segments[3] = encodeURIComponent(id);
          url.pathname = segments.join("/");
          return HttpClientRequest.setUrl(
            request,
            request.url.startsWith("/") ? url.pathname + url.search : url.href,
          );
        }),
      ),
    ),
  ).pipe(Layer.provide(dashboardHttpClient));
