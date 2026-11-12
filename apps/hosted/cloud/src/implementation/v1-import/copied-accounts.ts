/**
 * The one-off repair of the accounts of organizations the opt-in import copied before they moved
 * (`notes/v1-import.md`, "Repair of moved organizations"). Their move deployed apps before it took
 * v1's final tokens, so a deployment could renew a copied account with the copy's own refresh
 * token first, and it kept copied accounts whose provider the regenerated app changed. Each
 * account an earlier run saved now takes v1's final tokens as a move takes them, and follows its
 * app's provider (`updateCopiedAccount`). v1's tokens are final once it no longer serves the
 * organization, so only an organization that cut over is repaired.
 */
import { AccountId } from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { V1ImportDatabase, V1ImportUnavailable } from "../../contracts/v1-import.ts";
import { updateCopiedAccount } from "./items.ts";
import { movedOrganizationContext } from "./repair.ts";

const State = Schema.Array(Schema.Struct({ state: Schema.String }));

/** What the repair did with one copied account. */
export interface CopiedAccountRepair {
  readonly connection: string;
  readonly account: string;
  /** `replaced` when it took v1's tokens. */
  readonly tokens: "kept" | "replaced";
  /** Whether it moved to its app's provider. */
  readonly followed: boolean;
}

export interface CopiedAccountsRepair {
  readonly organization: string;
  readonly status: "repaired" | "not_cut_over" | "not_imported";
  readonly accounts: readonly CopiedAccountRepair[];
}

/** Repair the copied accounts of one organization that cut over (see the module comment). */
export const repairCopiedAccounts = (organization: string) =>
  Effect.gen(function* () {
    const sql = yield* Effect.flatten(V1ImportDatabase);
    const [recorded] = yield* sql`
      select state from private_v1_import_org where v1_org_id = ${organization}
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(State)),
      Effect.mapError(() => new V1ImportUnavailable()),
    );
    if (recorded?.state !== "cutover")
      return { organization, status: "not_cut_over", accounts: [] } satisfies CopiedAccountsRepair;
    const moved = yield* movedOrganizationContext(organization);
    if (moved?.context === undefined)
      return { organization, status: "not_imported", accounts: [] } satisfies CopiedAccountsRepair;
    const { context } = moved;
    const accounts: CopiedAccountRepair[] = [];
    for (const row of context.snapshot.connections) {
      const saved = yield* context.store.find("connection", row.row_id);
      if (saved?.status !== "imported" || saved.v2_id === null) continue;
      if ((yield* context.store.sinceImported("connection", row.row_id)) === "removed") continue;
      const updated = yield* updateCopiedAccount(context, row, AccountId.make(saved.v2_id));
      accounts.push({ connection: row.row_id, account: saved.v2_id, ...updated });
    }
    return { organization, status: "repaired", accounts } satisfies CopiedAccountsRepair;
  });
