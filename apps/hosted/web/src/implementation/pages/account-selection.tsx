import { DetailSkeleton } from "@executor-js/ui/dashboard/loading";
import { Exit } from "effect";
import { HostedFailure, useDashboardAtoms } from "../components/dashboard-bindings.tsx";
import { useAtomSet } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { AppId } from "@executor-js/sdk";
import type { SharedAudience } from "@executor-js/hosted-server/resource-access";
import type { Group } from "@executor-js/hosted-server/groups";
import { AccountSelectionForm } from "@executor-js/ui/dashboard/account-selection";
import { QueryView } from "@executor-js/ui/dashboard/context";
import { Button } from "@executor-js/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@executor-js/ui/components/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@executor-js/ui/components/select";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, ArrowLeft02Icon } from "@hugeicons/core-free-icons";
import { appAtom, connectAppAtom, appError } from "../../contracts/apps.ts";
import { appAccessAtom } from "../../contracts/resource-access.ts";
import { groupsAtom } from "../../contracts/groups.ts";
import { useOrganizationRoute } from "../components/organization.tsx";
import { AudienceInput, SharingFailure } from "../components/sharing.tsx";

/** Managers edit the existing fixed bindings, including explicit array selections. */
export function AccountSelectionPage({ appId }: { readonly appId: string }) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const atoms = useDashboardAtoms();
  const navigate = useNavigate();
  const app = AppId.make(appId);
  return (
    <div className="page setup-page w-full shrink-0 p-6 mx-auto max-w-212.5 max-[740px]:p-4">
      <Link
        to="/org/$organizationSlug/apps/$appId"
        params={{ organizationSlug, appId }}
        search={{ view: "accounts" }}
        className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground"
      >
        <HugeiconsIcon icon={ArrowLeft02Icon} size={14} />
        App
      </Link>
      <QueryView
        query={appAccessAtom({ organization, app })}
        Failure={HostedFailure}
        pending={<DetailSkeleton label="Loading account setup" />}
      >
        {(access) =>
          !access.canManage ? (
            <p>The app creator and organization admins can change its account selections.</p>
          ) : (
            <QueryView
              query={appAtom({ organization, app })}
              Failure={HostedFailure}
              pending={<DetailSkeleton label="Loading account setup" />}
            >
              {(app) => (
                <QueryView
                  query={atoms.inventory}
                  Failure={HostedFailure}
                  pending={<DetailSkeleton label="Loading available accounts" />}
                >
                  {(inventory) => (
                    <AccountSelectionForm
                      mutation={atoms.selectAccounts}
                      Failure={HostedFailure}
                      key={app.id}
                      app={app}
                      available={inventory.accounts}
                      connectAction={(requirement) => (
                        <ConnectAccount app={app.id} requirement={requirement} />
                      )}
                      finishAction={
                        <Link
                          to="/org/$organizationSlug/apps/$appId"
                          params={{ organizationSlug, appId }}
                          search={{ view: "accounts" }}
                        >
                          Finish later
                        </Link>
                      }
                      onSaved={() =>
                        navigate({
                          to: "/org/$organizationSlug/apps/$appId",
                          params: { organizationSlug, appId },
                          search: { view: "accounts" },
                        })
                      }
                    />
                  )}
                </QueryView>
              )}
            </QueryView>
          )
        }
      </QueryView>
    </div>
  );
}
function ConnectAccount({
  app,
  requirement,
}: {
  readonly app: AppId;
  readonly requirement: string;
}) {
  const { organization } = useOrganizationRoute();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="ghost" onClick={() => setOpen(true)}>
        <HugeiconsIcon icon={Add01Icon} size={14} />
        Add account
      </Button>
      {open && (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent className="max-h-[90dvh] overflow-auto">
            <DialogTitle>Connect account</DialogTitle>
            <DialogDescription>
              Choose a personal account or share one with your team.
            </DialogDescription>
            <QueryView
              query={groupsAtom(organization)}
              Failure={HostedFailure}
              pending={<DetailSkeleton label="Loading groups" />}
            >
              {(data) => (
                <ConnectionDestinationForm
                  app={app}
                  requirement={requirement}
                  groups={data.groups}
                />
              )}
            </QueryView>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
const initialDestination: { kind: "personal" | "shared"; audience: typeof SharedAudience.Type } = {
  kind: "personal",
  audience: { kind: "everyone" },
};
function ConnectionDestinationForm({
  app,
  requirement,
  groups,
}: {
  readonly app: AppId;
  readonly requirement: string;
  readonly groups: readonly Group[];
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const connect = useAtomSet(connectAppAtom, { mode: "promiseExit" });
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const form = useForm({
    defaultValues: initialDestination,
    onSubmit: async ({ value }) => {
      setError(undefined);
      const destination =
        value.kind === "personal"
          ? { kind: "personal" as const }
          : { kind: "shared" as const, audience: value.audience };
      const result = await connect({
        params: { organization, app },
        payload: { requirement, destination },
      });
      if (Exit.isFailure(result)) setError(appError(result.cause));
      else
        await navigate({
          to: "/org/$organizationSlug/connections/$connectionId",
          params: { organizationSlug, connectionId: result.value.id },
        });
    },
  });
  const pending = useStore(form.store, (state) => state.isSubmitting);
  const kind = useStore(form.store, (state) => state.values.kind);
  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        await form.handleSubmit();
      }}
    >
      <form.Field name="kind">
        {(field) => (
          <Select
            value={field.state.value}
            disabled={pending}
            onValueChange={(value) => {
              if (value === "personal" || value === "shared") field.handleChange(value);
            }}
          >
            <SelectTrigger aria-label="Account ownership" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="personal">Personal account</SelectItem>
              <SelectItem value="shared">Shared account</SelectItem>
            </SelectContent>
          </Select>
        )}
      </form.Field>
      {kind === "personal" && (
        <p className="text-sm text-muted-foreground">Only you can see and use this account.</p>
      )}
      <form.Field
        name="audience"
        validators={{
          onChangeListenTo: ["kind"],
          onChange: ({ value, fieldApi }) =>
            fieldApi.form.state.values.kind === "shared" &&
            value.kind === "groups" &&
            !value.groups.length
              ? "Choose at least one group."
              : undefined,
        }}
      >
        {(field) =>
          kind === "shared" ? (
            <AudienceInput
              mode="account"
              groups={groups}
              value={field.state.value}
              disabled={pending}
              onBlur={field.handleBlur}
              onChange={field.handleChange}
              error={
                field.state.meta.isTouched
                  ? field.state.meta.errors
                      .filter((message) => typeof message === "string")
                      .join(" ")
                  : undefined
              }
            />
          ) : null
        }
      </form.Field>
      {error && <SharingFailure title="Could not start account setup" message={error} />}
      <Button type="submit" loading={pending}>
        Continue
      </Button>
    </form>
  );
}
