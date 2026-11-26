import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Result, Schema } from "effect";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { appsManifest } from "../support/apps-release.ts";
import { releasedServer } from "../support/docker-release-server.ts";
import { connectionsPath } from "../support/app-accounts.ts";

const handleData = Buffer.from("executor.credential-handle.v1");
const handleKey = (secret: string) =>
  Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "executor credential handles", 32));
const derivedHandleKey = (encryptionKey: string) =>
  handleKey(
    createHmac("sha256", encryptionKey).update("executor credential handles").digest("hex"),
  );
const formerHandleKey = handleKey("service-binding");
const openHandle = (key: Buffer, handle: string) => {
  const bytes = Buffer.from(handle.slice("exsec_".length, -1), "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(handleData);
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString();
};
const sealHandle = (key: Buffer, contents: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(handleData);
  const sealed = Buffer.concat([cipher.update(contents), cipher.final(), cipher.getAuthTag()]);
  return `exsec_${Buffer.concat([iv, sealed]).toString("hex")}_`;
};

it.live(
  "released image keeps a credential handle app code kept usable across a restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const declared = "api.credential-restart.invalid";
        const server = yield* releasedServer;
        const source = `import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
const service = defineProvider({
  name: "Release handles",
  hosts: [${JSON.stringify(declared)}],
  auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) },
});
export default defineApp({ user: { accounts: { service } } }, {
  tools: router({
    token: query({ input: object({}) }, async (ctx) => ctx.user.accounts.service.fields.token),
    send: query({ input: object({ url: string(), token: string() }) }, async (_, { url, token }) => {
      const response = await fetch(url, { headers: { authorization: "Bearer " + token } });
      return { status: response.status, text: await response.text() };
    }),
  }),
});`;
        const app = yield* server.deploy("Release handles", [
          { path: "index.ts", content: source },
          appsManifest,
        ]);
        const path = `${server.prefix}/apps/${app.id}`;
        const Id = Schema.Struct({ id: Schema.String });
        const connection = yield* server.json(Id, connectionsPath(path, "user", "service"), {});
        const value = `synthetic-release-token-${randomUUID()}`;
        yield* server.json(Id, `${server.prefix}/connections/${connection.id}/submit`, {
          method: "key",
          label: "Release handles",
          fields: { token: value },
        });
        const call = <S extends Schema.Top>(schema: S, tool: string, input: object) =>
          server.json(schema, `${path}/tools/call`, {
            tool,
            input,
          });
        const kept = yield* call(Schema.String, "token", {});
        expect(kept).toMatch(/^exsec_[0-9a-f]+_$/);
        const Refused = Schema.Struct({
          status: Schema.Number,
          text: Schema.fromJsonString(
            Schema.Struct({
              refusal: Schema.Struct({ reason: Schema.String }),
            }),
          ),
        });
        const replay = call(Refused, "send", {
          url: "https://undeclared.credential-restart.invalid/kept",
          token: kept,
        });
        const opened = {
          status: 421,
          text: { refusal: { reason: "credential_host" } },
        };
        expect(yield* replay).toMatchObject(opened);
        const derived = derivedHandleKey(server.encryptionKey);
        const contents = yield* Effect.try(() => openHandle(derived, kept));
        expect(Result.isFailure(Result.try(() => openHandle(formerHandleKey, kept)))).toBe(true);
        const resealed = (key: Buffer) =>
          call(Refused, "send", {
            url: "https://undeclared.credential-restart.invalid/resealed",
            token: sealHandle(key, contents),
          });
        expect(yield* resealed(derived)).toMatchObject(opened);
        expect(yield* resealed(formerHandleKey)).toMatchObject({
          status: 421,
          text: { refusal: { reason: "credential_app" } },
        });
        yield* server.restart;
        expect(yield* replay).toMatchObject(opened);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  240_000,
);
