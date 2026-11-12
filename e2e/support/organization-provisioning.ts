/**
 * Wait for an organization's own background provisioning through the reads the dashboard uses.
 *
 * Creating an organization queues its Executor app, a managed key for each owner and admin, and
 * those keys' webhook sources. Background work installs them after the creating request answers,
 * so a scenario that starts before they land sees them arrive mid-scenario. Setup waits for the
 * scenario organization's app and keys by default; call {@link settleOrganization} for one a
 * scenario creates.
 *
 * It does not wait for the keys' webhook sources. Setting one up changes nothing a scenario reads
 * through the organization's apps, links or accounts: the Executor app declares no webhooks, so
 * it registers none. A redeploy of the Executor app sets them up again mid-scenario anyway. On
 * Cloud they go through the one schedule coordinator every organization shares, so waiting for
 * them made every scenario's setup wait on other organizations' work. `app-worker-budget`, which
 * counts the Worker that setup loads, waits for its own key's source to be ready.
 */
import { Clock, Effect, Schema } from "effect";
import { Api, SessionClients, body, type RequestFailed, type Session } from "./api.ts";
import { Inventory } from "./contracts.ts";
import type { Response } from "./platform.ts";

/** Setup's phase deadline is 60 seconds; this leaves the rest of setup room to report. */
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

/** What is still pending for the organization, or nothing once it has settled. */
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

/**
 * Wait until an organization a scenario created has its Executor app and one managed key linked
 * for each of `managers` (its owners and admins; members link their own). Fails after 30
 * seconds, naming what was still pending.
 */
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

/** The setup form of {@link settleOrganization}: it runs before case evidence exists. */
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
