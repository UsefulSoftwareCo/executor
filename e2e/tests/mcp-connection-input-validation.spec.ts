/** Connection names and agent IDs that storage cannot hold are bad requests, not a failed sign-in. */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { ConnectionView } from "../support/mcp-connections.ts";
import { scenarios } from "../test-plan.ts";

/** A NUL cannot be stored, a line break splits the title, and invisible text lists as blank. */
const refusedNames = ["Zero\u0000Width", "Two\nlines", "Tabbed\tname", "\u200b\u200b", "\u200d"];

layer(HostedLive, { excludeTestServices: true })("MCP connection input validation", (it) => {
  it.effect(scenarios.mcpConnectionInputValidation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const connections = `${prefix}/mcp-connections`;
        const refused = (label: string, response: { status: number; body: unknown }) =>
          expect(response.status, `${label}: ${JSON.stringify(response.body)}`).toBe(400);
        const count = () =>
          api
            .request(actors.owner, "GET", connections)
            .pipe(Effect.map((response) => (response.body as ReadonlyArray<unknown>).length));

        const id = randomUUID();
        const before = yield* count();

        // A refused name never reaches storage, so it is a bad request and creates nothing.
        for (const name of refusedNames) {
          refused(
            `create ${JSON.stringify(name)}`,
            yield* api.request(actors.owner, "POST", connections, { id, name, apps: [] }),
          );
        }
        expect(yield* count()).toBe(before);

        // Names in any script, with emoji, are ordinary text.
        const name = "日本語 👨‍👩‍👧 connection";
        const created = yield* body(
          ConnectionView,
          yield* api.request(actors.owner, "POST", connections, { id, name, apps: [] }),
        );
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "POST", `${connections}/${id}/revoke`).pipe(Effect.orDie),
        );
        expect(created.name).toBe(name);

        // An edit is held to the same rule and leaves the saved name as it was.
        for (const refusedName of refusedNames) {
          refused(
            `edit ${JSON.stringify(refusedName)}`,
            yield* api.request(actors.owner, "PUT", `${connections}/${id}`, {
              name: refusedName,
              apps: [],
            }),
          );
        }
        const listed = (yield* api.request(actors.owner, "GET", connections))
          .body as ReadonlyArray<{ id: string; name: string }>;
        expect(listed.find((connection) => connection.id === id)?.name).toBe(name);
        const renamed = yield* body(
          ConnectionView,
          yield* api.request(actors.owner, "PUT", `${connections}/${id}`, {
            name: "Renamed connection",
            apps: [],
          }),
        );
        expect(renamed.name).toBe("Renamed connection");

        // An ID with a control character is not an agent, a connection or a failed sign-in. An
        // unknown ID without one is still not found.
        refused(
          "revoke agent %00",
          yield* api.request(actors.owner, "POST", `${prefix}/mcp-agents/%00/revoke`),
        );
        refused(
          "revoke connection %00",
          yield* api.request(actors.owner, "POST", `${connections}/%00/revoke`),
        );
        expect(
          (yield* api.request(actors.owner, "POST", `${prefix}/mcp-agents/unknown/revoke`)).status,
        ).toBe(404);
      }),
    ),
  );
});
