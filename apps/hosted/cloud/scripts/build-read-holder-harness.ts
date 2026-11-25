import { Effect } from "effect";
import { RuntimeBuildUnavailable, type BuildId } from "@executor-js/sdk/core";
import { cachedRuntimeBuilds } from "../src/implementation/runtime-build-cache.ts";

const silentUpstream = (url: string) => fetch(url);
let reads = 0;
let hungEnded = 0;
const record = (build: BuildId, hang: string | undefined) =>
  Effect.gen(function* () {
    reads += 1;
    if (hang !== undefined)
      yield* Effect.tryPromise({
        try: () => silentUpstream(hang),
        catch: () => new RuntimeBuildUnavailable(),
      }).pipe(Effect.ensuring(Effect.sync(() => void (hungEnded += 1))));
    return {
      format: 1 as const,
      mainModule: "main.js",
      modules: {
        "main.js": `export default { fetch() { return new Response(${JSON.stringify(build)}); } };`,
      },
      database: false,
      protocol: 1,
    };
  });

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/state") return Response.json({ reads, hungEnded });
    const build = url.searchParams.get("build") as BuildId;
    const hang = url.searchParams.get("hang") ?? undefined;
    const read = cachedRuntimeBuilds(
      "https://harness.invalid",
      {
        record: (id) => record(id, hang) as never,
        framework: () => Effect.fail(new RuntimeBuildUnavailable()),
      },
      () => Effect.void,
    );
    const before = reads;
    const started = Date.now();
    const exit = await Effect.runPromiseExit(read(build));
    return Response.json({
      ok: exit._tag === "Success",
      ms: Date.now() - started,
      reads: reads - before,
      error: exit._tag === "Failure" ? String(exit.cause).slice(0, 200) : undefined,
    });
  },
};
