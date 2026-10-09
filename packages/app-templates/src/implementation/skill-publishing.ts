/** Publish an explicitly supplied set of public skill documents using the standard directory index. */
import { prepareAppSkills } from "@executor-js/sdk/skill-source";
import { SourceFiles, type SourceFile } from "@executor-js/sdk/core";
import { Crypto, Effect, Layer } from "effect";
import { Hex } from "effect/encoding";
import { HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";

/**
 * Public assets are selected by the host, never looked up from installed or customer apps.
 * The files load and the index is built on the first request, not while the server starts;
 * the published documents are immutable, so later requests reuse the same responses.
 */
export const publishedSkillRoutes = (files: Effect.Effect<readonly SourceFile[]>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const headers = { "cache-control": "no-cache" };
      const publish = Effect.gen(function* () {
        const skills = yield* prepareAppSkills(
          SourceFiles.make([
            { path: "index.ts", content: "" },
            ...(yield* files).filter((file) => file.path.startsWith("skills/")),
          ]),
        ).pipe(Effect.orDie);
        const entries = yield* Effect.forEach(skills, (skill) =>
          Effect.gen(function* () {
            const version = yield* crypto
              .digest("SHA-256", new TextEncoder().encode(JSON.stringify(skill)))
              .pipe(Effect.map(Hex.encode), Effect.orDie);
            return {
              name: skill.name,
              description: skill.description,
              version,
              files: skill.files.map((file) => file.path),
            };
          }),
        );
        return new Map<string, HttpServerResponse.HttpServerResponse>([
          ["index.json", HttpServerResponse.jsonUnsafe({ skills: entries }, { headers })],
          ...skills.flatMap((skill) =>
            skill.files.map(
              (file) =>
                [
                  `${skill.name}/${file.path}`,
                  HttpServerResponse.text(file.content, {
                    contentType: "text/markdown; charset=utf-8",
                    headers,
                  }),
                ] as const,
            ),
          ),
        ]);
      });
      let published: ReadonlyMap<string, HttpServerResponse.HttpServerResponse> | undefined;
      return HttpRouter.add(
        "GET",
        "/.well-known/agent-skills/*",
        Effect.gen(function* () {
          if (published === undefined) published = yield* publish;
          const response = published.get((yield* HttpRouter.params)["*"] ?? "");
          if (response !== undefined) return response;
          // The same response as a path the router does not know.
          return yield* new HttpServerError.HttpServerError({
            reason: new HttpServerError.RouteNotFound({
              request: yield* HttpServerRequest.HttpServerRequest,
            }),
          });
        }),
      );
    }),
  );
