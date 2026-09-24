/** Publish an explicitly supplied set of public skill documents using the standard directory index. */
import { prepareAppSkills } from "@executor-js/sdk/skill-source";
import { SourceFiles, type SourceFile } from "@executor-js/sdk/core";
import { Crypto, Effect, Encoding, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

/** Public assets are selected by the host, never looked up from installed or customer apps. */
export const publishedSkillRoutes = (files: readonly SourceFile[]) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const skills = yield* prepareAppSkills(
        SourceFiles.make([
          { path: "index.ts", content: "" },
          ...files.filter((file) => file.path.startsWith("skills/")),
        ]),
      ).pipe(Effect.orDie);
      const entries = yield* Effect.forEach(skills, (skill) =>
        Effect.gen(function* () {
          const version = yield* crypto
            .digest("SHA-256", new TextEncoder().encode(JSON.stringify(skill)))
            .pipe(Effect.map(Encoding.encodeHex), Effect.orDie);
          return {
            name: skill.name,
            description: skill.description,
            version,
            files: skill.files.map((file) => file.path),
          };
        }),
      );
      const prefix = "/.well-known/agent-skills";
      const headers = { "cache-control": "no-cache" };
      return Layer.mergeAll(
        HttpRouter.add(
          "GET",
          `${prefix}/index.json`,
          HttpServerResponse.jsonUnsafe({ skills: entries }, { headers }),
        ),
        ...skills.flatMap((skill) =>
          skill.files.map((file) =>
            HttpRouter.add(
              "GET",
              `${prefix}/${skill.name}/${file.path}`,
              HttpServerResponse.text(file.content, {
                contentType: "text/markdown; charset=utf-8",
                headers,
              }),
            ),
          ),
        ),
      );
    }),
  );
