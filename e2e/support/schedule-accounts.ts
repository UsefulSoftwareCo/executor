/** Apps whose schedules depend on the accounts they run with. */
import { appsManifest } from "./apps-release.ts";

/**
 * An app whose schedule declarations depend on the account they are evaluated with: each account
 * of its provider names, in its `job` field, the schedule its evaluation declares. `body` is the
 * app's definition.
 */
export const jobFiles = (body: string) => [
  {
    path: "index.ts",
    content: `import { defineApp, defineProvider, secrets, mutation, userInterval, object, string, router, type MutationContext } from "apps";
const service = defineProvider({ name: "Schedule job fixture", auth: { key: secrets({ label: "Key", fields: object({ job: string() }) }) } });
const requirements = { user: { accounts: { service } } };
const tick = mutation({ input: object({}) }, async (ctx: MutationContext<typeof requirements>) => ctx.user.accounts.service.id);
export default defineApp(requirements, ${body});`,
  },
  appsManifest,
];
/** Every account declares the schedule its `job` field names. */
export const declaresEachJob = `async (ctx) => ({ tools: router({ tick }),
  schedules: { [ctx.user.accounts.service.fields.job]: userInterval({ minutes: 1 }, tick, {}) } })`;
/** Evaluation fails for the account whose job is `job`; the others declare their schedule. */
export const failsFor = (job: string) => `async (ctx) => {
  if (ctx.user.accounts.service.fields.job === ${JSON.stringify(job)}) throw new Error("This evaluation fails on purpose");
  return { tools: router({ tick }), schedules: { [ctx.user.accounts.service.fields.job]: userInterval({ minutes: 1 }, tick, {}) } };
}`;
/** Only the account whose job is `job` declares a schedule. */
export const declaresOnly = (job: string) => `async (ctx) => ({ tools: router({ tick }),
  schedules: ctx.user.accounts.service.fields.job === ${JSON.stringify(job)} ? { [${JSON.stringify(job)}]: userInterval({ minutes: 1 }, tick, {}) } : {} })`;

/**
 * An app with one plain requirement, whose provider no many() requirement uses, so linking another
 * account replaces the one linked before. Its `tick` schedule records the account each run used.
 */
export const plainTickFiles = [
  {
    path: "index.ts",
    content: `import { defineApp, defineProvider, secrets, query, mutation, userInterval, object, string, router,
  type QueryContext, type MutationContext } from "apps";
const service = defineProvider({ name: "Schedule mail fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
const requirements = { user: { accounts: { service } } };
const tick = mutation({ input: object({}) }, async (ctx: MutationContext<typeof requirements>) => {
  ctx.sql.exec("INSERT INTO ticks (account) VALUES (?)", ctx.user.accounts.service.id);
  return ctx.user.accounts.service.id;
});
const ticks = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) =>
  ctx.sql.exec<{ account: string }>("SELECT account FROM ticks ORDER BY seq").toArray().map((row) => row.account));
export default defineApp(requirements, async () => ({
  tools: router({ tick, ticks }),
  schedules: { tick: userInterval({ minutes: 1 }, tick, {}) },
}));`,
  },
  {
    path: "migrations/0001_ticks.sql",
    content: "CREATE TABLE ticks (seq INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL);\n",
  },
  appsManifest,
];
