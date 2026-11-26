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

export const annotateRequestSpan = (attributes: Readonly<Record<string, unknown>>) =>
  Effect.withFiber((fiber) =>
    Effect.sync(() => {
      const span = requestSpanOf(fiber.context);
      if (span === undefined) return;
      for (const [key, value] of Object.entries(attributes)) span.attribute(key, value);
    }),
  );

export const currentRequestSpan: Effect.Effect<Option.Option<Tracer.Span>> = Effect.withFiber(
  (fiber) => Effect.succeed(Option.fromNullishOr(requestSpanOf(fiber.context))),
);
