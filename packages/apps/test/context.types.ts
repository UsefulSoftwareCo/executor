/** Compile-time regressions for standalone and contextually inferred handler definitions. */
import {
  defineApp,
  defineDatabase,
  dynamicSkills,
  defineProvider,
  secrets,
  table,
  object,
  string,
  query,
  mutation,
  type QueryContext,
  type MutationContext,
  type WebhookContext,
} from "../src/index.ts";
import { queryReference } from "../src/client.ts";

const service = defineProvider({
  name: "Context service",
  auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) },
});
const requirements = {
  accounts: { service },
  database: defineDatabase({ messages: table({ body: string() }) }),
};
type QueryCtx = QueryContext<typeof requirements>;
type MutationCtx = MutationContext<typeof requirements>;
type WebhookCtx = WebhookContext<typeof requirements>;

const read = query({ input: object({ prefix: string() }) }, async (ctx: QueryCtx, input) => {
  const token: string = ctx.accounts.service.fields.token;
  const prefix: string = input.prefix;
  // @ts-expect-error Accounts are derived from the requirements.
  ctx.accounts.other;
  // @ts-expect-error Tables are derived from the requirements.
  ctx.db.other;
  // @ts-expect-error Queries cannot write.
  await ctx.db.messages.insert({ body: prefix });
  return {
    tokenPresent: token.length > 0,
    rows: await ctx.db.messages.withIndex("by_creation").collect(),
  };
});
const write = mutation({ input: object({ body: string() }) }, async (ctx: MutationCtx, input) => {
  // @ts-expect-error Insert fields retain their types.
  await ctx.db.messages.insert({ body: 123 });
  return ctx.db.messages.insert(input);
});
defineApp(requirements, { queries: { read }, mutations: { write } });
queryReference<typeof read>("read");

defineApp(requirements, {
  queries: {
    read: query({ input: object({}) }, async (ctx) => {
      const token: string = ctx.accounts.service.fields.token;
      // @ts-expect-error Inline handlers retain account types.
      ctx.accounts.missing;
      // @ts-expect-error Inline queries remain read-only.
      await ctx.db.messages.insert({ body: token });
      return ctx.db.messages.withIndex("by_creation").collect();
    }),
  },
  mutations: {
    write: mutation({ input: object({ body: string() }) }, async (ctx, input) =>
      ctx.db.messages.insert(input),
    ),
  },
});
defineApp(requirements, async () => ({
  queries: {
    read: query({ input: object({}) }, async (ctx) =>
      ctx.db.messages.withIndex("by_creation").collect(),
    ),
  },
}));

// @ts-expect-error A handler requiring storage cannot be mounted without it.
defineApp({ accounts: { service } }, { queries: { read } });
defineApp(
  { accounts: {}, database: requirements.database },
  // @ts-expect-error Required accounts must match the installed app declaration.
  { queries: { read } },
);
defineApp(
  { accounts: { service }, database: defineDatabase({ other: table({ body: string() }) }) },
  // @ts-expect-error A different table schema cannot satisfy this handler.
  { queries: { read } },
);

const requiresWrites = query({ input: object({}) }, async (ctx: MutationCtx) =>
  ctx.db.messages.insert({ body: "bad" }),
);
// @ts-expect-error A query must receive a read-only context, even with an explicit incorrect annotation.
defineApp(requirements, { queries: { requiresWrites } });

const webhook = async (ctx: WebhookCtx) => {
  // @ts-expect-error Background handlers cannot request interactive input.
  await ctx.elicit({});
  return ctx.db.messages.insert({ body: ctx.accounts.service.fields.token });
};
void webhook;
// @ts-expect-error Database-bound operation constructors have been removed.
requirements.database.query;

// Package metadata is not app behavior, including when supplied through an inferred variable.
const namedDefinition = { name: "Wrong source", queries: { read } };
// @ts-expect-error Package names belong in package.json.
defineApp(requirements, namedDefinition);
// @ts-expect-error Dynamic factories cannot supply a package name either.
defineApp(requirements, async () => namedDefinition);

// Skills may be resolved or returned by a loader that runs only for skill reads.
defineApp({ accounts: {} }, { skills: [] });
defineApp({ accounts: {} }, { dynamicSkills: dynamicSkills({ list: () => [] }) });
defineApp({ accounts: {} }, async () => ({
  skills: [],
  dynamicSkills: dynamicSkills({ list: async () => [] }),
}));
// @ts-expect-error Static skills are resolved; load remote skills with dynamicSkills.
defineApp({ accounts: {} }, { skills: () => [] });
// @ts-expect-error dynamicSkills is built with the dynamicSkills helper.
defineApp({ accounts: {} }, { dynamicSkills: () => [] });
// @ts-expect-error A dynamic skills list must return skills.
dynamicSkills({ list: () => "skills" });
