import { Clock, Effect, Schema } from "effect";
import { Api, SessionClients, body, type RequestFailed, type Session } from "./api.ts";
import { Inventory } from "./contracts.ts";
import type { Response } from "./platform.ts";

const budgetMs = 30_000;
const Resources = Schema.Struct({ pendingApp: Schema.Boolean });

type Request = (session: Session, path: string) => Effect.Effect<Response, RequestFailed>;

class ProvisioningUnsettled extends Schema.TaggedError<ProvisioningUnsettled>()(
  "ProvisioningUnsettled",
  { message: Schema.String },
) {}

const read = <A>(schema: Schema.ConstraintDecoder<A, never>, response: Response) =>
  response.status === 200
    ? body(schema, response)
    : Effect.fail(
        new ProvisioningUnsettled({
          message: `a provisioning read responded ${response.status}: ${JSON.stringify(response.body).slice(0, 500)}`,
        }),
      );

const pending = (
  request: Request,
  organizationId: string,
  managers: Readonly<Record<string, Session>>,
) =>
  Effect.gen(function* () {
    const root = `/api/organizations/${organizationId}`;
    const [first] = Object.values(managers);
    if (first === undefined) return yield* Effect.die(new Error("No organization manager given"));
    const waiting: string[] = [];
    const { pendingApp } = yield* read(Resources, yield* request(first, `${root}/resources`));
    if (pendingApp) waiting.push("team installation (resources.pendingApp)");
    for (const [role, session] of Object.entries(managers)) {
      const inventory = yield* read(Inventory, yield* request(session, `${root}/inventory`));
      const app = inventory.apps.find((item) => item.slug === "executor");
      if (app === undefined) {
        waiting.push(`${role}: Executor app not in inventory`);
        continue;
      }
      const links = inventory.links.filter((link) => link.app === app.id);
      if (links.length !== 1)
        waiting.push(`${role}: ${links.length} managed Executor key links, expected 1`);
    }
    return waiting;
  });

const settle = (
  request: Request,
  organizationId: string,
  managers: Readonly<Record<string, Session>>,
) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + budgetMs;
    for (;;) {
      const waiting = yield* pending(request, organizationId, managers);
      if (waiting.length === 0) return;
      if ((yield* Clock.currentTimeMillis) >= deadline)
        return yield* new ProvisioningUnsettled({
          message: `Organization ${organizationId} provisioning did not finish within ${budgetMs / 1000} s; still pending: ${waiting.join("; ")}`,
        });
      yield* Effect.sleep("100 millis");
    }
  }).pipe(Effect.withSpan("e2e.settleOrganization", { attributes: { organizationId } }));

export const settleOrganization = (
  organizationId: string,
  managers: Readonly<Record<string, Session>>,
) =>
  Effect.gen(function* () {
    const api = yield* Api;
    return yield* settle(
      (session, path) => api.request(session, "GET", path),
      organizationId,
      managers,
    );
  });

export const prepareOrganization = (
  organizationId: string,
  managers: Readonly<Record<string, Session>>,
) =>
  Effect.gen(function* () {
    const clients = yield* SessionClients;
    return yield* settle(
      (session, path) => clients.request(session, "GET", path),
      organizationId,
      managers,
    );
  });
