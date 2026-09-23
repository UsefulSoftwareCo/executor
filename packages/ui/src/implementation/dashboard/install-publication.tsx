/** Public discovery passes the reviewed revision to the common copy operation. */
import { useAtomValue } from "@effect/atom-react";
import type { App } from "@executor-js/sdk";
import type { Publication } from "@executor-js/app-registry/contracts";
import type { AppAcknowledgement, AppManagementProps } from "../../contracts/app-management.ts";
import { AppCreateForm } from "./app-create.tsx";
import { Button } from "../components/button.tsx";

/** Public and owned copies share naming, pending, failure, and completion behavior. */
export function InstallPublication<E>({
  publication,
  atoms,
  Failure,
  onApp,
  onInstalled,
  onBack,
}: AppManagementProps<E> & {
  readonly publication: typeof Publication.Type;
  readonly onApp: AppAcknowledgement;
  readonly onInstalled: (app: App) => void | Promise<void>;
  readonly onBack: () => void;
}) {
  const mutation = atoms.copy({ package: publication.name, commit: publication.commit });
  const result = useAtomValue(mutation);
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <Button variant="ghost" disabled={result.waiting} onClick={onBack}>
        Back to Add app
      </Button>
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">Make a copy</h1>
        <p className="mt-1 text-sm text-muted-foreground">{publication.name}</p>
      </div>
      <AppCreateForm
        mutation={mutation}
        Failure={Failure}
        initialName={publication.name.slice(publication.name.indexOf("/") + 1)}
        input={(name) => ({ name, onApp })}
        label="Make a copy"
        onCancel={onBack}
        onCreated={onInstalled}
        beforeName={
          <>
            <p className="text-sm">{publication.description}</p>
            <p className="text-xs text-muted-foreground">
              Published source{" "}
              <code title={publication.commit}>{publication.commit.slice(0, 7)}</code>
            </p>
          </>
        }
      >
        {() => (
          <p className="text-xs leading-5 text-muted-foreground">
            Your copy is independent. Connected accounts and app data aren’t copied.
          </p>
        )}
      </AppCreateForm>
    </div>
  );
}
