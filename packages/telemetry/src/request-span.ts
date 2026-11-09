/**
 * The request's span: the span that stands for one request in the Worker or process serving it.
 * Facts about the whole request, such as who made it and why it was refused, belong there, where a
 * query of requests by status, route and host finds them. Code deep inside a request runs in child
 * spans (`auth.authenticate`, a handler's own spans), so it names the request's span explicitly
 * instead of annotating its current one.
 *
 * That span is the nearest ancestor of kind `server` (the HTTP server tracer's span, or a remote
 * call's), else the outermost span this process started, such as a batched dashboard read's
 * (`dashboard.batch.read`), whose parent is the browser's.
 */
import { Context, Effect, Option, Tracer } from "effect";

const requestSpanOf = (context: Context.Context<never>): Tracer.Span | undefined => {
  let span: Tracer.AnySpan | undefined = Option.getOrUndefined(
    Context.getOption(context, Tracer.ParentSpan),
  );
  let outermost: Tracer.Span | undefined;
  while (span !== undefined && span._tag === "Span") {
    if (span.kind === "server") return span;
    outermost = span;
    span = Option.getOrUndefined(span.parent);
  }
  return outermost;
};

/** Set attributes on the request's span. Outside any span this does nothing. */
export const annotateRequestSpan = (attributes: Readonly<Record<string, unknown>>) =>
  Effect.withFiber((fiber) =>
    Effect.sync(() => {
      const span = requestSpanOf(fiber.context);
      if (span === undefined) return;
      for (const [key, value] of Object.entries(attributes)) span.attribute(key, value);
    }),
  );

/** The request's span, to hold on to beyond the current fiber's span. */
export const currentRequestSpan: Effect.Effect<Option.Option<Tracer.Span>> = Effect.withFiber(
  (fiber) => Effect.succeed(Option.fromNullishOr(requestSpanOf(fiber.context))),
);
