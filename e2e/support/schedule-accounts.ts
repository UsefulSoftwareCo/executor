import { appsManifest } from "./apps-release.ts";

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
export const declaresEachJob = `async (ctx) => ({ tools: router({ tick }),
  schedules: { [ctx.user.accounts.service.fields.job]: userInterval({ minutes: 1 }, tick, {}) } })`;
export const failsFor = (job: string) => `async (ctx) => {
  if (ctx.user.accounts.service.fields.job === ${JSON.stringify(job)}) throw new Error("This evaluation fails on purpose");
  return { tools: router({ tick }), schedules: { [ctx.user.accounts.service.fields.job]: userInterval({ minutes: 1 }, tick, {}) } };
}`;
export const declaresOnly = (job: string) => `async (ctx) => ({ tools: router({ tick }),
  schedules: ctx.user.accounts.service.fields.job === ${JSON.stringify(job)} ? { [${JSON.stringify(job)}]: userInterval({ minutes: 1 }, tick, {}) } : {} })`;

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
