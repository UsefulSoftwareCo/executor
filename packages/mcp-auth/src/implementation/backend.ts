/** Apply one grant at every shared MCP operation; hosts retain their existing resource checks. */
import type { McpBackend } from "@executor-js/mcp";
import { ElicitationFailed, type AppId } from "@executor-js/sdk/core";
import { Effect } from "effect";
import { permitsApp, permitsTool, permittedAppIds } from "@executor-js/authorization";
import { GrantForbidden, grantAuthorization, type Grant } from "../contracts/grant.ts";

/** Re-read authority per operation, including while an execution resumes within one HTTP call. */
export const restrictMcpBackend = <E extends Error, G extends Error>(
  backend: McpBackend<E>,
  current: Effect.Effect<Grant, G>,
): McpBackend<E | G | GrantForbidden> => {
  const authority = current.pipe(Effect.map((grant) => grantAuthorization(grant.policy)));
  const check = (app: AppId, tool?: Parameters<typeof permitsTool>[2]) =>
    authority.pipe(
      Effect.flatMap((grant) =>
        (tool === undefined ? permitsApp(grant, app) : permitsTool(grant, app, tool))
          ? Effect.void
          : Effect.fail(new GrantForbidden()),
      ),
    );
  return {
    listSkills: (input) => check(input.app).pipe(Effect.andThen(() => backend.listSkills(input))),
    readSkill: (input) => check(input.app).pipe(Effect.andThen(() => backend.readSkill(input))),
    listApps: (input) =>
      Effect.gen(function* () {
        const grant = yield* authority;
        const ids = permittedAppIds(grant, input?.ids);
        return yield* backend.listApps({ ids });
      }),
    listTargets: (input) => check(input.app).pipe(Effect.andThen(() => backend.listTargets(input))),
    listTools: (input) =>
      Effect.gen(function* () {
        yield* check(input.app);
        const page = yield* backend.listTools(input);
        const grant = yield* authority;
        return {
          ...page,
          items: page.items.filter((tool) => permitsTool(grant, input.app, tool.name, "discover")),
        };
      }),
    callTool: (input, options) =>
      check(input.app, input.tool).pipe(Effect.andThen(() => backend.callTool(input, options))),
    resumeInvocation: (request, response, options) =>
      check(request.invocation.app, request.invocation.tool).pipe(
        Effect.andThen(() => backend.resumeInvocation(request, response, options)),
      ),
    authorizeElicitation: (input) =>
      check(input.app, input.tool).pipe(
        Effect.mapError(() => new ElicitationFailed({ reason: "forbidden" })),
        Effect.andThen(() => backend.authorizeElicitation(input)),
      ),
  };
};
