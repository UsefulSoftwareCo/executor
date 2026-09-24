/** Mutable publication fixture outside the real Executor server and isolated app runtime. */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Ref } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { createServer } from "node:http";

type FileFailure = "oversized" | "encoding" | "redirect";

/** Serve well-known and GitHub-shaped publications with controlled changes and incomplete generations. */
export const skillUpstream = Effect.gen(function* () {
  const state = yield* Ref.make<{
    version: number;
    broken: boolean;
    traversal: boolean;
    malformed: "github" | "well-known" | undefined;
    fileFailure: FileFailure | undefined;
  }>({ version: 1, broken: false, traversal: false, malformed: undefined, fileFailure: undefined });
  const requests = yield* Ref.make<string[]>([]);
  const route = HttpRouter.add(
    "GET",
    "/*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://fixture.invalid");
      yield* Ref.update(requests, (items) => [...items, url.pathname]);
      const current = yield* Ref.get(state);
      const sha = String(current.version).repeat(40);
      if (url.pathname.startsWith("/github/repos/synthetic/skills/commits/")) {
        const ref = url.pathname.split("/").at(-1);
        return HttpServerResponse.jsonUnsafe({ sha: ref === "HEAD" ? sha : ref });
      }
      if (url.pathname.startsWith("/github/repos/synthetic/skills/git/trees/"))
        return HttpServerResponse.jsonUnsafe({
          truncated: false,
          tree: [
            { path: "skills/github-guide/SKILL.md", type: "blob", mode: "100644" },
            { path: "skills/github-guide/references/example.md", type: "blob", mode: "100644" },
          ],
        });
      if (url.pathname.endsWith("/index.json"))
        return HttpServerResponse.jsonUnsafe({
          skills: [
            {
              name: "remote-guide",
              version: String(current.version),
              files: ["SKILL.md", current.traversal ? "../private.txt" : "references/example.md"],
            },
          ],
        });
      const github = url.pathname.startsWith("/github/synthetic/skills/");
      const name = github ? "github-guide" : "remote-guide";
      const version = github ? url.pathname.split("/")[4]?.slice(0, 1) : String(current.version);
      if (url.pathname.endsWith("/SKILL.md"))
        return HttpServerResponse.text(
          current.malformed === (github ? "github" : "well-known")
            ? "Missing frontmatter"
            : `---\nname: ${name}\ndescription: Published instructions.\n---\n# Guide ${version}\nRead [example](references/example.md).`,
        );
      if (url.pathname.endsWith("/references/example.md")) {
        if (current.fileFailure === "oversized")
          return HttpServerResponse.text("x".repeat(2_000_001));
        if (current.fileFailure === "encoding")
          return HttpServerResponse.uint8Array(Uint8Array.of(0xff));
        if (current.fileFailure === "redirect") return HttpServerResponse.redirect("/private.txt");
        return current.broken
          ? HttpServerResponse.empty({ status: 503 })
          : HttpServerResponse.text(`# Reference ${version}`);
      }
      return HttpServerResponse.empty({ status: 404 });
    }),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(route, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return {
    url: `http://127.0.0.1:${server.address.port}`,
    publish: (
      version: number,
      options: {
        broken?: boolean;
        traversal?: boolean;
        malformed?: "github" | "well-known";
        fileFailure?: FileFailure;
      } = {},
    ) =>
      Ref.set(state, {
        version,
        broken: options.broken ?? false,
        traversal: options.traversal ?? false,
        malformed: options.malformed,
        fileFailure: options.fileFailure,
      }),
    requests: Ref.get(requests),
  };
});
