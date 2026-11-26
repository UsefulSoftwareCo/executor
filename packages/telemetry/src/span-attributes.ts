import { Effect, Exit, Layer, Option, Schema, Tracer } from "effect";
import { HttpClient, HttpMiddleware } from "effect/http";
import { declaredOwner, ownerAttribute } from "./ownership.ts";
import { recordedCause } from "./recorded-failure.ts";

class LogicalOperationFailed extends Schema.TaggedError<LogicalOperationFailed>()(
  "LogicalOperationFailed",
  {},
) {}

const httpNamespaces = ["http.", "url.", "server.", "client.", "user_agent."];

export const httpSpanAttributeAllowlist: ReadonlySet<string> = new Set([
  "http.request.method",
  "http.response.status_code",
  "server.address",
  "url.scheme",
  "url.path",
  "http.route",
  "http.request.header.content-type",
  "http.request.header.content-length",
  "http.request.header.user-agent",
  "http.response.header.content-type",
  "http.response.header.content-length",
  "user_agent.original",
  "client.address",
]);

export const spanAttributeAllowed = (key: string): boolean => {
  const name = key.toLowerCase();
  return (
    !httpNamespaces.some((namespace) => name.startsWith(namespace)) ||
    httpSpanAttributeAllowlist.has(name)
  );
};

const allowedEntries = (attributes: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(attributes).filter(([key]) => spanAttributeAllowed(key)));

export const recordRoute = (template: `/${string}`) =>
  Effect.annotateCurrentSpan("http.route", template);

export const routeTemplates = (templates: Iterable<`/${string}`>) => {
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

const allowlistedSpan = (span: Tracer.Span, ended: () => void): Tracer.Span => {
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
    end: (endTime: bigint, exit: Exit.Exit<unknown, unknown>) => {
      span.end(
        endTime,
        Exit.isSuccess(exit)
          ? span.attributes.get("executor.outcome") === "failed"
            ? Exit.fail(new LogicalOperationFailed())
            : exit
          : Exit.failCause(recordedCause(exit.cause)),
      );
      ended();
    },
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

const httpSpanNames = Layer.mergeAll(
  Layer.succeed(HttpMiddleware.SpanNameGenerator, (request) => `http.server ${request.method}`),
  Layer.succeed(HttpClient.SpanNameGenerator, (request) => `http.client ${request.method}`),
);

export const spanAttributes = (
  clock?: "system" | "cloudflare-io",
  recordAll = false,
  ended: () => void = () => {},
): Layer.Layer<never> => Layer.merge(httpSpanNames, tracerWithAllowlist(clock, recordAll, ended));

const tracerWithAllowlist = (
  clock: "system" | "cloudflare-io" | undefined,
  recordAll: boolean,
  ended: () => void,
): Layer.Layer<never> =>
  Layer.effect(Tracer.Tracer)(
    Tracer.Tracer.pipe(
      Effect.map((tracer) => ({
        ...tracer,
        span: (options) => {
          const span = allowlistedSpan(
            tracer.span(recordAll ? { ...options, sampled: true } : options),
            ended,
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

export const allowlistedSpans = spanAttributes();
