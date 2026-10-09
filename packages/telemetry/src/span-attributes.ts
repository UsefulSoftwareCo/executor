/**
 * HTTP span attributes are allowlisted. Nothing else in an HTTP namespace is recorded.
 *
 * Effect's HTTP client and its server tracer write every request and response
 * header, the full URL and the query string onto their spans. This product
 * routes provider API keys through header and query names chosen by an imported
 * OpenAPI spec, and carries bearer capabilities such as the one-click
 * unsubscribe token in a query parameter and in a redirect `Location` header.
 * No list of dangerous names can keep up with that, so HTTP spans record a
 * fixed set of attributes and drop everything else.
 *
 * The allowlist runs on the tracer because that is the single point where the
 * client tracer and the server tracer meet. Effect's
 * `HttpClient.TracerHeaderFilter` controls outgoing headers only: nothing
 * configures the URL attributes on either side, and the server tracer has no
 * header hook at all. A second filter on the client would duplicate this one
 * rather than complete it, so this is the only boundary.
 *
 * Attributes outside these namespaces are the product's own and pass through.
 */
import { Effect, Exit, Layer, Option, Schema, Tracer } from "effect";
import { declaredOwner, ownerAttribute } from "./ownership.ts";
import { recordedCause } from "./recorded-failure.ts";

class LogicalOperationFailed extends Schema.TaggedError<LogicalOperationFailed>()(
  "LogicalOperationFailed",
  {},
) {}

/** Namespaces the HTTP client and server tracers write into. */
const httpNamespaces = ["http.", "url.", "server.", "client.", "user_agent."];

/** Every HTTP attribute an exported span may carry. */
export const httpSpanAttributeAllowlist: ReadonlySet<string> = new Set([
  "http.request.method",
  "http.response.status_code",
  "server.address",
  "url.scheme",
  // Path only. `url.full` and `url.query` carry the query string, so neither is listed.
  // Once a route is recorded, the path is that route's template (`allowlistedSpan`).
  "url.path",
  // The router's matched path template, such as `/api/organizations/:organization`; no values.
  "http.route",
  "http.request.header.content-type",
  "http.request.header.content-length",
  "http.request.header.user-agent",
  "http.response.header.content-type",
  "http.response.header.content-length",
  // The server tracer records the user agent a second time under its own name.
  "user_agent.original",
]);

/** Record this attribute? HTTP names must be allowlisted; product names pass through. */
export const spanAttributeAllowed = (key: string): boolean => {
  const name = key.toLowerCase();
  return (
    !httpNamespaces.some((namespace) => name.startsWith(namespace)) ||
    httpSpanAttributeAllowlist.has(name)
  );
};

const allowedEntries = (attributes: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(attributes).filter(([key]) => spanAttributeAllowed(key)));

/**
 * Record the template of a route whose path an app or its caller chose, in place of the router's
 * wildcard: an app's own page or asset, or an app's outbound request. Its last parameter stands
 * for the rest of the path. It annotates the current span, so call it from the request's handler.
 */
export const recordRoute = (template: `/${string}`) =>
  Effect.annotateCurrentSpan("http.route", template);

/**
 * A fixed set of endpoint templates served under one wildcard route, such as Better Auth's
 * endpoints under `/api/auth/*`. `:name` stands for one segment. `record` names the request's
 * endpoint by its template and leaves the wildcard for any path the set does not hold, so a span
 * keeps which endpoint ran without any segment the caller chose.
 */
export const routeTemplates = (templates: Iterable<`/${string}`>) => {
  // A fixed segment wins over a parameter in the same place, as in the routers these serve.
  const known = [...new Set(templates)]
    .map((template) => ({ template, segments: template.split("/") }))
    .sort(
      (a, b) =>
        a.segments.filter((segment) => segment.startsWith(":")).length -
        b.segments.filter((segment) => segment.startsWith(":")).length,
    );
  const match = (path: string) => {
    const segments = path.split("/");
    return known.find(
      (route) =>
        route.segments.length === segments.length &&
        route.segments.every((segment, index) =>
          segment.startsWith(":") ? segments[index] !== "" : segment === segments[index],
        ),
    )?.template;
  };
  return {
    match,
    record: (path: string) => {
      const template = match(path);
      return template === undefined ? Effect.void : recordRoute(template);
    },
  };
};

/**
 * Delegate to the real span and drop disallowed attributes before they are set.
 * The exporter still sees one span; the values simply never arrive.
 *
 * Once the router records a server span's route, its `url.path` is that route's template. A
 * route's parameters are chosen by apps and callers: a skill or tool name, an organization's slug
 * where its ID would also do. The same parameter name can hold an opaque ID on one route and a
 * chosen name on another, so no value is kept, such as `/v1/apps/:app/skills/:name`. A wildcard
 * keeps no part of the rest of the path either: an SSO provider's ID, a site page or a scanner's
 * probe all record `/api/auth/*`, `/docs/*` or `/api/*`. A handler that serves a fixed set of
 * endpoints under its wildcard names the request's endpoint with `routeTemplates`.
 */
const allowlistedSpan = (span: Tracer.Span): Tracer.Span => {
  let path = false;
  let route: string | undefined;
  return {
    _tag: "Span",
    get name() {
      return span.name;
    },
    get spanId() {
      return span.spanId;
    },
    get traceId() {
      return span.traceId;
    },
    get parent() {
      return span.parent;
    },
    get annotations() {
      return span.annotations;
    },
    get status() {
      return span.status;
    },
    get attributes() {
      return span.attributes;
    },
    get links() {
      return span.links;
    },
    get sampled() {
      return span.sampled;
    },
    get kind() {
      return span.kind;
    },
    // A successful transport can carry a failed domain operation. The producer
    // explicitly marks that outcome; arbitrary result payloads are never inspected.
    // A failure records the fixed message an error declares in place of an app's text.
    end: (endTime: bigint, exit: Exit.Exit<unknown, unknown>) =>
      span.end(
        endTime,
        Exit.isSuccess(exit)
          ? span.attributes.get("executor.outcome") === "failed"
            ? Exit.fail(new LogicalOperationFailed())
            : exit
          : Exit.failCause(recordedCause(exit.cause)),
      ),
    attribute: (key: string, value: unknown) => {
      if (!spanAttributeAllowed(key)) return;
      if (key === "url.path" && typeof value === "string") {
        path = true;
        span.attribute(key, route ?? value);
        return;
      }
      if (key === "http.route" && typeof value === "string") {
        route = value;
        if (path) span.attribute("url.path", value);
      }
      span.attribute(key, value);
    },
    event: (name: string, startTime: bigint, attributes?: Record<string, unknown>) =>
      span.event(
        name,
        startTime,
        attributes === undefined ? undefined : allowedEntries(attributes),
      ),
    addLinks: (links: ReadonlyArray<Tracer.SpanLink>) => span.addLinks(links),
  };
};

/** Wrap whichever tracer is already in scope; provide this above the exporter. */
export const spanAttributes = (
  clock?: "system" | "cloudflare-io",
  recordAll = false,
): Layer.Layer<never> =>
  Layer.effect(Tracer.Tracer)(
    Tracer.Tracer.pipe(
      Effect.map((tracer) => ({
        ...tracer,
        span: (options) => {
          const span = allowlistedSpan(
            tracer.span(recordAll ? { ...options, sampled: true } : options),
          );
          if (
            recordAll &&
            Option.isSome(options.parent) &&
            options.parent.value._tag === "ExternalSpan"
          )
            span.attribute("executor.trace.parent_sampled", options.parent.value.sampled);
          if (clock !== undefined) span.attribute("executor.clock.type", clock);
          const owner = declaredOwner(options.annotations);
          if (owner !== undefined) span.attribute(ownerAttribute, owner);
          return span;
        },
      })),
    ),
  );

/** Header and URL filtering without making an unsupported claim about the runtime clock. */
export const allowlistedSpans = spanAttributes();
