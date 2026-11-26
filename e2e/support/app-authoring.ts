import { Effect, Schema } from "effect";
import { Api, body, type Session } from "./api.ts";

export const Workspace = Schema.Struct({
  revision: Schema.Struct({ code: Schema.String, commit: Schema.String }),
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
export const Committed = Schema.Struct({ revision: Workspace.fields.revision });
export const saveAndDeploy = (
  actor: Session,
  path: string,
  input: {
    readonly files: readonly { readonly path: string; readonly content: string }[];
  },
) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const read = yield* api.request(actor, "GET", `${path}/workspace`);
    if (read.status !== 200) return read;
    const before = yield* body(Workspace, read);
    const saved = yield* api.request(actor, "POST", `${path}/commits`, {
      expected: before.revision.commit,
      files: input.files,
      message: "Save app changes",
    });
    if (saved.status !== 200) return saved;
    const committed = yield* body(Committed, saved);
    return yield* api.request(actor, "POST", `${path}/deploy`, {
      commit: committed.revision.commit,
    });
  });

export const helloIndex = `import { defineApp, object, query, router } from "apps";

export default defineApp({}, async () => ({
  tools: router({
    hello: query({ description: "Say hello", input: object({}) }, async () => ({ message: "Hello" })),
  }),
}));
`;
export const helloPackage = (version: string) =>
  JSON.stringify({ name: "hello", private: true, type: "module", dependencies: { apps: version } });
