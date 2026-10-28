/** Same-root additions preserve an existing source's paths and current resolution. */
import { Effect } from "effect";
import type { AppOperation } from "../contracts/operations.ts";
import type { AppRouter, DynamicRouter } from "../contracts/router.ts";
import { fixedRouter } from "./router-catalog.ts";

export const extendRoot = (
  source: AppRouter | DynamicRouter,
  additions: Readonly<Record<string, AppOperation>>,
): AppRouter | DynamicRouter => {
  const names = Object.keys(additions);
  const conflicts = (name: string) =>
    names.some((key) => name === key || name.startsWith(`${key}.`));
  const refuse = () => new Error("Same-root router addition collides with its source");
  if (source.kind === "router") {
    for (const name of names) if (Object.hasOwn(source.children, name)) throw refuse();
    return { ...source, children: { ...source.children, ...additions } };
  }
  const fixed = fixedRouter(additions);
  const list = () =>
    source
      .list()
      .pipe(
        Effect.flatMap((base) =>
          base.some((tool) => conflicts(tool.name))
            ? Effect.fail(refuse())
            : fixed.list().pipe(Effect.map((extra) => [...base, ...extra])),
        ),
      );
  const summaries = () =>
    (source.summaries === undefined ? source.list() : source.summaries()).pipe(
      Effect.flatMap((base) =>
        base.some((tool) => conflicts(tool.name))
          ? Effect.fail(refuse())
          : fixed.summaries!().pipe(Effect.map((extra) => [...base, ...extra])),
      ),
    );
  return {
    ...source,
    list,
    summaries,
    resolve: (name) => {
      if (!Object.hasOwn(additions, name)) return source.resolve(name);
      // A changing remote source cannot silently acquire or replace the local name.
      return source
        .list()
        .pipe(
          Effect.flatMap((base) =>
            base.some((tool) => conflicts(tool.name)) ? Effect.fail(refuse()) : fixed.resolve(name),
          ),
        );
    },
    describe: (name) =>
      Object.hasOwn(additions, name)
        ? list().pipe(Effect.map((tools) => tools.find((tool) => tool.name === name)))
        : source.describe === undefined
          ? source.list().pipe(Effect.map((tools) => tools.find((tool) => tool.name === name)))
          : source.describe(name),
  };
};
