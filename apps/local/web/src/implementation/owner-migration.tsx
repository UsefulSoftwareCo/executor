import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { Alert } from "@executor-js/ui/components/alert";
import { blockedRecovery, type LocalOwnerMigration } from "@executor-js/local-server/contracts";
import { ownerMigrationAtom } from "../contracts/owner-migration.ts";

type Collision = LocalOwnerMigration["collisions"][number];
type Blocked = LocalOwnerMigration["blocked"][number];

const quoted = (owners: ReadonlyArray<string>) => owners.map((owner) => `“${owner}”`).join(", ");
const owned = (record: { readonly id: string; readonly owner?: string | undefined }) =>
  record.owner === undefined ? record.id : `${record.id} (owner “${record.owner}”)`;

/** What collides, and which records a person renames or removes so the rest can move. */
const collision = (each: Collision) => {
  const records = each.records.map(owned).join(", ");
  switch (each.kind) {
    case "app_name":
      return `Apps named “${each.key}”: ${records}. Rename or remove all but one.`;
    case "app_slug":
      return `Apps with the slug “${each.key}”: ${records}. Rename or remove all but one.`;
    case "oauth_client_credentials":
      return `OAuth clients holding the same credentials for ${each.key}: ${records}. Remove all but one.`;
  }
};

const unreadable = {
  oauth_client: "OAuth client",
  oauth_grant: "The OAuth sign-in of account",
  oauth_sign_in: "Pending OAuth sign-in",
  tool_approval: "Pending approval",
  account_connection: "Account connection",
} satisfies Record<Blocked["kind"], string>;

/** A record the move cannot read, and how it stops being in the way. */
const blocked = (record: Blocked) => {
  const { action, request } = blockedRecovery(record);
  return {
    key: `${record.kind} ${record.id}`,
    text: `${unreadable[record.kind]} ${owned(record)}. ${action}${request === undefined ? "." : ":"}`,
    request,
  };
};

/**
 * Records agents saved under other owners before local assigned them stay apart until data step
 * 7 moves them to `local`. Until then their apps are listed but cannot be connected, so this says
 * why and what a person does about it. Nothing shows once the step has moved them.
 */
export function OwnerMigrationBanner() {
  const result = useAtomValue(ownerMigrationAtom);
  if (!AsyncResult.isSuccess(result) || result.value === null) return null;
  const migration = result.value;
  const owners = quoted(migration.owners);
  const items =
    migration.status === "blocked"
      ? migration.blocked.map(blocked)
      : migration.status === "collision"
        ? migration.collisions.map((each) => {
            const text = collision(each);
            return { key: text, text, request: undefined };
          })
        : [];
  return (
    <div className="owner-migration mx-auto my-0 w-full min-w-0 max-w-315 shrink-0 [padding:24px_24px_0] max-[1000px]:[padding:20px_20px_0] max-[740px]:[padding:18px_16px_0]">
      <Alert className="flex items-start gap-2.5 p-[15px] border border-border rounded-[7px] [&_>_svg]:text-destructive [&_>_svg]:shrink-0 [&_>_svg]:mt-0.5 [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere [&_>_div]:flex-1 [&_strong]:text-[13px] [&_strong]:font-medium [&_p]:text-[12px] [&_p]:text-muted-foreground [&_p]:mt-0.75 [&_li]:text-[12px] [&_li]:mt-1 [&_ul]:list-disc [&_ul]:pl-4">
        <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} aria-hidden size={17} />
        <div>
          {migration.status === "pending" ? (
            <>
              <strong>Records of other owners wait to move</strong>
              <p>
                {`Records of ${owners} are kept apart from yours, so their apps cannot be connected. Restart Executor without EXECUTOR_DATA_STEPS=report to move them to “${migration.to}”.`}
              </p>
            </>
          ) : (
            <>
              <strong>Records of other owners could not move</strong>
              <p>
                {migration.status === "blocked"
                  ? `Records of ${owners} were not moved to “${migration.to}”, because Executor cannot read these records. No product rows or ciphertext changed; this attempt was recorded in the journal. Their apps cannot be connected until they move.`
                  : `Records of ${owners} were not moved to “${migration.to}”, because these would collide. No product rows or ciphertext changed; this attempt was recorded in the journal. Their apps cannot be connected until they move.`}
              </p>
              <ul>
                {items.map((item) => (
                  <li key={item.key}>
                    {item.text}
                    {item.request === undefined ? null : (
                      <>
                        {" "}
                        <code>{item.request}</code>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              {migration.status === "blocked" &&
              migration.blocked.some((record) => blockedRecovery(record).request !== undefined) ? (
                <p>
                  Send each request to this server with the API key as a bearer token:{" "}
                  <code>Authorization: Bearer $EXECUTOR_API_KEY</code>.
                </p>
              ) : null}
              <p>Then restart Executor.</p>
            </>
          )}
        </div>
      </Alert>
    </div>
  );
}
