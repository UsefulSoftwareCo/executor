import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import { AsyncResult } from "effect/unstable/reactivity";
import { Exit } from "effect";
import { useState } from "react";
import { impersonateAtom, operatorUsersAtom } from "./auth.ts";

/** Native Better Auth directory and impersonation controls shared by hosted environments. */
export function UserPicker({
  currentUser,
  onSessionChange,
}: {
  readonly currentUser: string;
  readonly onSessionChange: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const users = useAtomValue(operatorUsersAtom(search));
  const refresh = useAtomRefresh(operatorUsersAtom(search));
  const impersonate = useAtomSet(impersonateAtom, { mode: "promiseExit" });
  const pending = useAtomValue(impersonateAtom);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(draft.trim());
        }}
      >
        <Input
          aria-label="Search users by email"
          placeholder="Search by email"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      <div className="mt-3 max-h-72 space-y-2 overflow-y-auto" aria-live="polite">
        {users.waiting && <p className="text-sm text-muted-foreground">Loading users…</p>}
        {AsyncResult.isFailure(users) && (
          <>
            <p role="alert">Could not load users.</p>
            <Button onClick={refresh}>Try again</Button>
          </>
        )}
        {AsyncResult.isSuccess(users) && (
          <>
            <p className="text-xs text-muted-foreground">
              Showing {users.value.users.length} of {users.value.total} users
            </p>
            {users.value.users.map((user) => (
              <Button
                key={user.id}
                variant="outline"
                className="h-auto w-full justify-start px-3 py-3 text-left"
                aria-label={`Impersonate ${user.email}`}
                disabled={
                  pending.waiting ||
                  users.waiting ||
                  user.id === currentUser ||
                  user.role?.split(",").includes("admin")
                }
                onClick={async () => {
                  setError(null);
                  const result = await impersonate(user.id);
                  if (Exit.isFailure(result))
                    setError("Could not impersonate this user. Check your access and try again.");
                  else {
                    onSessionChange();
                    window.location.assign("/");
                  }
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{user.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
                </span>
              </Button>
            ))}
            {users.value.users.length === 0 && (
              <p className="text-sm text-muted-foreground">No matching users.</p>
            )}
          </>
        )}
      </div>
      {error && (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Actions use the selected user’s access. Impersonation lasts up to one hour.
      </p>
    </>
  );
}
