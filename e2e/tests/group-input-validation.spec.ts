/** Group input that storage cannot hold is a bad request, not an unavailable service to retry. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

const Group = Schema.Struct({
  id: Schema.String,
  revision: Schema.String,
  name: Schema.String,
  description: Schema.String,
  memberIds: Schema.Array(Schema.String),
});
const Groups = Schema.Struct({ groups: Schema.Array(Group) });

/** A NUL cannot be stored, a line break splits the title, and invisible text lists as blank. */
const refusedNames = ["Zero\u0000Width", "Two\nlines", "Tabbed\tname", "\u200b\u200b", "\u200d"];

layer(HostedLive, { excludeTestServices: true })("Group input validation", (it) => {
  it.effect(scenarios.groupInputValidation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api;
        const prefix = `/api/organizations/${actors.organization.id}/groups`;
        const suffix = randomUUID().slice(0, 8);
        const list = () => api.request(actors.owner, "GET", prefix).pipe(Effect.flatMap(read));
        const read = (response: Parameters<typeof body>[1]) => body(Groups, response);
        const refused = (label: string, response: { status: number; body: unknown }) =>
          expect(response.status, `${label}: ${JSON.stringify(response.body)}`).toBe(400);

        const created = yield* body(
          Group,
          yield* api.request(actors.owner, "POST", prefix, {
            name: `Validation ${suffix}`,
            description: "",
            memberIds: [],
          }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const current = (yield* list()).groups.find((group) => group.id === created.id);
            if (current === undefined) return;
            expect(
              (yield* api.request(actors.owner, "DELETE", `${prefix}/${current.id}`, {
                revision: current.revision,
              })).status,
            ).toBe(200);
          }).pipe(Effect.orDie),
        );
        const before = (yield* list()).groups.length;

        // Create and edit both refuse the name as a bad request, never as unavailable storage.
        for (const name of refusedNames) {
          const label = JSON.stringify(name);
          refused(
            `create ${label}`,
            yield* api.request(actors.owner, "POST", prefix, {
              name,
              description: "",
              memberIds: [],
            }),
          );
          refused(
            `edit ${label}`,
            yield* api.request(actors.owner, "PATCH", `${prefix}/${created.id}`, {
              name,
              description: "",
              memberIds: [],
              revision: created.revision,
            }),
          );
        }
        // So do a NUL in the description, a member id, the group id and the revision.
        refused(
          "description with NUL",
          yield* api.request(actors.owner, "POST", prefix, {
            name: `Described ${suffix}`,
            description: "x\u0000y",
            memberIds: [],
          }),
        );
        refused(
          "member id with NUL",
          yield* api.request(actors.owner, "POST", prefix, {
            name: `Member ${suffix}`,
            description: "",
            memberIds: ["\u0000"],
          }),
        );
        refused("group id with NUL", yield* api.request(actors.owner, "GET", `${prefix}/%00`));
        refused(
          "revision with NUL",
          yield* api.request(actors.owner, "DELETE", `${prefix}/${created.id}`, {
            revision: "\u0000",
          }),
        );

        // Nothing was created, renamed or removed by the refused requests.
        const unchanged = yield* list();
        expect(unchanged.groups).toHaveLength(before);
        expect(unchanged.groups.find((group) => group.id === created.id)).toEqual(created);

        // Other scripts, joined emoji and a description with line breaks stay valid.
        const name = `日本語 👨‍👩‍👧 ${suffix}`;
        const description = "First line\nSecond line\tindented";
        const edited = yield* api.request(actors.owner, "PATCH", `${prefix}/${created.id}`, {
          name,
          description,
          memberIds: [],
          revision: created.revision,
        });
        expect(edited.status, JSON.stringify(edited.body)).toBe(200);
        const saved = yield* body(
          Group,
          yield* api.request(actors.owner, "GET", `${prefix}/${created.id}`),
        );
        expect(saved).toMatchObject({ name, description });
      }),
    ),
  );
});
