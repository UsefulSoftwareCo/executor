/** Deletion order and grant pagination for the Better Auth records an organization owns. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { deleteOrganizationRecords } from "../src/implementation/organization-records.ts";
import { OrganizationId } from "../src/contracts/organization.ts";

const organization = OrganizationId.make("org_synthetic");

type Row = Record<string, string | null>;
type Where = { readonly field: string; readonly value: unknown; readonly operator?: string };
type Query = {
  readonly model: string;
  readonly where?: ReadonlyArray<Where>;
  readonly limit?: number;
  readonly sortBy?: { readonly field: string; readonly direction: "asc" | "desc" };
};

/** Better Auth applies this default whenever a caller omits `limit`. */
const adapterDefaultLimit = 100;

const matches = (row: Row, where: ReadonlyArray<Where>) =>
  where.every(({ field, value, operator }) =>
    operator === "gt" ? String(row[field]) > String(value) : row[field] === value,
  );

/** An in-memory stand-in that reproduces the adapter behaviour the real code depends on. */
const makeAdapter = (rows: Record<string, Array<Row>>, failOn?: string) => {
  const deletions: Array<string> = [];
  const remove = (model: string, where: ReadonlyArray<Where>) => {
    if (model === failOn) throw new Error("synthetic adapter failure");
    deletions.push(model);
    rows[model] = (rows[model] ?? []).filter((row) => !matches(row, where));
  };
  const adapter = {
    findOne: ({ model, where = [] }: Query) =>
      Promise.resolve((rows[model] ?? []).find((row) => matches(row, where)) ?? null),
    findMany: ({ model, where = [], limit, sortBy }: Query) => {
      const found = (rows[model] ?? []).filter((row) => matches(row, where));
      if (sortBy)
        found.sort((left, right) =>
          String(left[sortBy.field]).localeCompare(String(right[sortBy.field])),
        );
      return Promise.resolve(found.slice(0, limit ?? adapterDefaultLimit));
    },
    delete: ({ model, where = [] }: Query) => {
      remove(model, where);
      return Promise.resolve();
    },
    deleteMany: ({ model, where = [] }: Query) => {
      remove(model, where);
      return Promise.resolve();
    },
  };
  return { adapter, deletions, rows };
};

const store = (grants: number) => {
  const ids = Array.from(
    { length: grants },
    (_, index) => `grant_${String(index).padStart(5, "0")}`,
  );
  return {
    organization: [{ id: organization, logo: "icons/synthetic.png" }],
    member: [{ id: "mem_owner", organizationId: organization, role: "owner" }],
    invitation: [{ id: "inv_one", organizationId: organization }],
    mcpGrant: ids.map((id) => ({ id, resource: organization })),
    oauthAccessToken: ids.map((id) => ({ id: `at_${id}`, referenceId: id })),
    oauthRefreshToken: ids.map((id) => ({ id: `rt_${id}`, referenceId: id })),
    oauthConsent: ids.map((id) => ({ id: `cs_${id}`, referenceId: id })),
  } satisfies Record<string, Array<Row>>;
};

const run = (adapter: unknown) =>
  // The fake implements the members the function actually uses.
  deleteOrganizationRecords(adapter as never, organization);

test("every MCP grant is revoked, not just the adapter's default page", async () => {
  const { adapter, rows } = makeAdapter(store(adapterDefaultLimit * 2 + 37));
  const saved = await Effect.runPromise(run(adapter));

  assert.equal(saved.logo, "icons/synthetic.png");
  assert.deepEqual(rows.mcpGrant, []);
  for (const model of ["oauthAccessToken", "oauthRefreshToken", "oauthConsent"] as const)
    assert.deepEqual(rows[model], [], `${model} rows survived the purge`);
});

test("the organization row is deleted before its member rows", async () => {
  const { adapter, deletions, rows } = makeAdapter(store(3));
  await Effect.runPromise(run(adapter));

  assert.ok(
    deletions.indexOf("organization") < deletions.indexOf("member"),
    `Expected the organization row first, got ${deletions.join(", ")}`,
  );
  // No step may leave a live organization with no members, which nobody could administer.
  assert.deepEqual(rows.organization, []);
  assert.deepEqual(rows.member, []);
  assert.deepEqual(rows.invitation, []);
});

test("a failure while revoking grants leaves the organization administrable", async () => {
  const { adapter, rows } = makeAdapter(store(3), "mcpGrant");
  const failure = await Effect.runPromise(Effect.flip(run(adapter)));

  assert.equal(failure._tag, "AuthenticationUnavailable");
  // The owner can still reach the endpoint and retry the whole removal.
  assert.equal(rows.organization?.length, 1);
  assert.equal(rows.member?.length, 1);
});

test("an organization that is already gone is refused rather than half-deleted", async () => {
  const { adapter, deletions } = makeAdapter({ ...store(3), organization: [] });
  const failure = await Effect.runPromise(Effect.flip(run(adapter)));

  assert.equal(failure._tag, "OrganizationForbidden");
  assert.deepEqual(deletions, []);
});
