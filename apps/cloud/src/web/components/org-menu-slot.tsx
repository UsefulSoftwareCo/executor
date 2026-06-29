import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { trackEvent } from "@executor-js/react/api/analytics";
import { Button } from "@executor-js/react/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@executor-js/react/components/dialog";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@executor-js/react/components/dropdown-menu";
import { useAuth } from "../auth";
import { organizationsAtom } from "../auth";
import { CreateOrganizationFields, useCreateOrganizationForm } from "./create-organization-form";

// ---------------------------------------------------------------------------
// Cloud-only org-switcher slot for the shared shell's account dropdown.
//
// The shared `Shell` renders this `orgMenuSlot` ABOVE its API-keys link. Cloud
// is the only product with multiple organizations, so the switcher + create-org
// dialog live here and are injected, keeping the shared shell provider-neutral.
// The create-org dialog is controlled by local state so its `DialogContent`
// can live outside the dropdown menu while the trigger sits inside it.
// ---------------------------------------------------------------------------

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="ml-auto size-3 text-muted-foreground">
      <path
        d="M3.5 8.5L6.5 11.5L12.5 5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function OrganizationSwitcherItems(props: { activeOrganizationId: string | null }) {
  const organizations = useAtomValue(organizationsAtom);

  // Switching orgs is now a pure URL navigation: the session authenticates the
  // user to ALL their orgs, and the slug in the path scopes every request (the
  // `x-executor-organization` header). No cookie to rewrite, no server switch
  // call — just land on the other org's URL root and the whole app re-scopes.
  const handleSwitch = (organization: { id: string; slug: string }) => {
    if (organization.id === props.activeOrganizationId) return;
    trackEvent("org_switched", { success: true });
    window.location.href = `/${organization.slug}`;
  };

  return AsyncResult.match(organizations, {
    onInitial: () => <DropdownMenuItem disabled>Loading…</DropdownMenuItem>,
    onFailure: () => <DropdownMenuItem disabled>Failed to load organizations</DropdownMenuItem>,
    onSuccess: ({ value }) =>
      value.organizations.length === 0 ? (
        <DropdownMenuItem disabled>No organizations</DropdownMenuItem>
      ) : (
        <>
          {value.organizations.map((organization: { id: string; name: string; slug: string }) => {
            const isActive = organization.id === props.activeOrganizationId;
            return (
              <DropdownMenuItem
                key={organization.id}
                disabled={isActive}
                onClick={() => {
                  handleSwitch(organization);
                }}
                className="text-xs"
              >
                <span className="min-w-0 flex-1 truncate">{organization.name}</span>
                {isActive && <CheckIcon />}
              </DropdownMenuItem>
            );
          })}
        </>
      ),
  });
}

export function OrgMenuSlot() {
  const auth = useAuth();
  const [createOrganizationOpen, setCreateOrganizationOpen] = useState(false);

  const suggestedOrganizationName =
    auth.status === "authenticated" && auth.user.name?.trim() !== "" && auth.user.name != null
      ? `${auth.user.name}'s Organization`
      : "New Organization";

  const form = useCreateOrganizationForm({
    defaultName: suggestedOrganizationName,
    // Land on the new org's URL root — a reload would keep the old slug and
    // the slug gate would switch the session right back.
    onSuccess: (org) => {
      window.location.href = `/${org.slug}`;
    },
  });

  if (auth.status !== "authenticated") return null;

  const openCreateOrganization = () => {
    form.reset(suggestedOrganizationName);
    setCreateOrganizationOpen(true);
  };

  return (
    <>
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
        Organization
      </DropdownMenuLabel>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="text-xs">
          <span className="min-w-0 flex-1 truncate">
            {auth.organization?.name ?? "No organization"}
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-56">
          <OrganizationSwitcherItems activeOrganizationId={auth.organization?.id ?? null} />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-xs"
            onSelect={(event) => {
              event.preventDefault();
              openCreateOrganization();
            }}
          >
            Create organization
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />

      <Dialog
        open={createOrganizationOpen}
        onOpenChange={(open) => {
          setCreateOrganizationOpen(open);
          if (!open) form.reset(suggestedOrganizationName);
        }}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Create organization</DialogTitle>
            <DialogDescription className="text-sm leading-relaxed">
              Add another organization under your current account and switch into it immediately.
            </DialogDescription>
          </DialogHeader>

          <CreateOrganizationFields
            name={form.name}
            onNameChange={(name) => {
              form.setName(name);
              if (form.error) form.setError(null);
            }}
            error={form.error}
            onSubmit={() => void form.submit()}
          />

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm" disabled={form.creating}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              size="sm"
              onClick={() => void form.submit()}
              disabled={!form.canSubmit || form.creating}
            >
              {form.creating ? "Creating…" : "Create organization"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
