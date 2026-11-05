import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { trackEvent } from "@executor-js/react/api/analytics";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@executor-js/react/components/dropdown-menu";
import { CREATE_ORG_PATH } from "../../auth/route-paths";
import { useAuth } from "../auth";
import { organizationsAtom } from "../auth";

// ---------------------------------------------------------------------------
// Cloud-only org-switcher slot for the shared shell's account dropdown.
//
// The shared `Shell` renders this `orgMenuSlot` ABOVE its API-keys link. Cloud
// is the only product with multiple organizations, so the switcher lives here
// and is injected, keeping the shared shell provider-neutral. v1 creates no
// organizations: the switcher's last item opens Executor v2, where new ones
// are created, in a new tab like the sidebar's other links to v2.
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

  if (auth.status !== "authenticated") return null;

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
          {/* A document navigation: the auth gate answers /create-org with
              v2's sign-up page. */}
          <DropdownMenuItem asChild className="text-xs">
            <a
              href={CREATE_ORG_PATH}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackEvent("v2_new_org_opened")}
            >
              New organization in Executor v2
            </a>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
    </>
  );
}
