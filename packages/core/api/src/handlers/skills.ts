import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import { parseGitHubSkillSource, type Skill, type SkillSummary } from "@executor-js/sdk";
import { makeHostedHttpClientLayer } from "@executor-js/sdk/host-internal";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { importSkillsFromGitHub, parsedSourceOrError } from "../skills/github-import";
import { capture } from "@executor-js/api";

// GitHub is public internet, so the default hosted client — which refuses
// private and loopback addresses — is the right guard regardless of what the
// host allows integrations to reach.
const githubHttpClient = makeHostedHttpClientLayer();

const summaryToResponse = (skill: SkillSummary) => ({
  owner: skill.owner,
  name: skill.name,
  description: skill.description,
  frontmatter: skill.frontmatter,
  files: skill.files,
  createdAt: skill.createdAt.getTime(),
  updatedAt: skill.updatedAt.getTime(),
});

const skillToResponse = (skill: Skill) => ({
  ...summaryToResponse(skill),
  files: skill.files,
});

export const SkillsHandlers = HttpApiBuilder.group(ExecutorApi, "skills", (handlers) =>
  handlers
    .handle("list", () =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const skills = yield* executor.skills.list();
          return skills.map(summaryToResponse);
        }),
      ),
    )
    .handle("get", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return skillToResponse(yield* executor.skills.get(params));
        }),
      ),
    )
    .handle("save", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return skillToResponse(yield* executor.skills.save(payload));
        }),
      ),
    )
    .handle("import", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const source = yield* parsedSourceOrError(parseGitHubSkillSource(payload.source));
          return yield* importSkillsFromGitHub(source);
        }).pipe(Effect.provide(githubHttpClient)),
      ),
    )
    .handle("remove", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          yield* executor.skills.remove(params);
          return { removed: true };
        }),
      ),
    ),
);
