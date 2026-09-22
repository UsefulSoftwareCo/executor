import { EmptyState } from "@executor-js/ui/dashboard/empty-state";
import { resourceDirectoryAtom } from "../../contracts/resource-access.ts";
import { QueryView } from "@executor-js/ui/dashboard/context";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { Cause, Exit, Option } from "effect";
import { useEffect, useId, useRef, useState } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { Link, useNavigate } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlertCircleIcon,
  Add01Icon,
  ArrowLeft02Icon,
  UserGroupIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import { Avatar, AvatarFallback } from "@executor-js/ui/components/avatar";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@executor-js/ui/components/dialog";
import { PageFrame, PageHeader } from "@executor-js/ui/dashboard/page";
import { productTitle, useDocumentTitle } from "@executor-js/ui/hooks/document-title";
import type { Group, GroupMember, GroupsView } from "@executor-js/hosted-server/groups";
import { useOrganizationRoute } from "../components/organization.tsx";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { groupsAtom, saveGroupAtom, removeGroupAtom } from "../../contracts/groups.ts";
import { appError, type HostedError } from "../../contracts/errors.ts";
import { GroupConflict } from "@executor-js/hosted-server/groups";
import { Alert, AlertTitle, AlertDescription } from "@executor-js/ui/components/alert";

/** Shared hosted groups page. A reload reads persisted membership, never fixture data. */
export function GroupsPage({ id }: { readonly id?: string }) {
  const { organization } = useOrganizationRoute();
  const result = useAtomValue(groupsAtom(organization));
  const refresh = useAtomRefresh(groupsAtom(organization));
  const data = AsyncResult.value(result);
  useDocumentTitle(productTitle("Groups"));
  return (
    <PageFrame>
      <PageHeader title="Groups" description="Organize the people in your team." />
      {AsyncResult.isFailure(result) && <HostedFailure cause={result.cause} retry={refresh} />}
      {Option.isSome(data) ? (
        <GroupContent key={`${organization}:${id ?? "list"}`} data={data.value} id={id} />
      ) : (
        !AsyncResult.isFailure(result) && (
          <div
            role="status"
            aria-label="Loading groups"
            className="min-h-48 rounded-lg border bg-muted/30 p-5 text-sm text-muted-foreground"
          >
            Loading groups…
          </div>
        )
      )}
    </PageFrame>
  );
}
function GroupContent({
  data,
  id,
}: {
  readonly data: typeof GroupsView.Type;
  readonly id: string | undefined;
}) {
  const { organization, slug: organizationSlug, role } = useOrganizationRoute();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<Group | "new" | null>(null);
  const [removing, setRemoving] = useState<Group | null>(null);
  const [removeError, setRemoveError] = useState<Cause.Cause<HostedError>>();
  const remove = useAtomSet(removeGroupAtom(organization), { mode: "promiseExit" });
  const deletion = useAtomValue(removeGroupAtom(organization));
  const mutation = useAtomValue(saveGroupAtom(organization));
  const admin = data.canManage && (role === "admin" || role === "owner");
  const selected = data.groups.find((group) => group.id === id);
  const filtered = data.groups
    .filter((group) => group.name.toLowerCase().includes(search.toLowerCase()))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      {id && (
        <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2">
          <Link to="/org/$organizationSlug/groups" params={{ organizationSlug }}>
            <HugeiconsIcon icon={ArrowLeft02Icon} size={15} />
            All groups
          </Link>
        </Button>
      )}
      {id ? (
        selected ? (
          <>
            <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">{selected.name}</h2>
                {selected.description && (
                  <p className="mt-1 text-sm text-muted-foreground">{selected.description}</p>
                )}
              </div>
              {admin && (
                <Button variant="outline" onClick={() => setEdit(selected)}>
                  Edit group
                </Button>
              )}
            </div>
            <h3 className="mb-3 text-sm font-medium">Members · {selected.memberIds.length}</h3>
            <Members
              members={data.members.filter((member) => selected.memberIds.includes(member.id))}
            />
            <GroupApps group={selected.id} />
            {admin && (
              <div className="mt-8 border-t pt-5">
                <h3 className="text-sm font-medium text-destructive">Delete group</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Organization members and apps are kept.
                </p>
                <Button
                  variant="destructive"
                  className="mt-3"
                  onClick={() => {
                    setRemoving(selected);
                    setRemoveError(undefined);
                  }}
                >
                  Delete group
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <h2 className="font-medium">Group unavailable</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              This group is unavailable or you do not have access. Ask an organization admin.
            </p>
          </div>
        )
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-md border px-3 sm:max-w-80">
              <HugeiconsIcon icon={Search01Icon} size={16} className="text-muted-foreground" />
              <input
                className="w-full bg-transparent outline-none max-sm:text-base"
                aria-label="Search groups"
                placeholder="Search groups…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            {admin && (
              <Button onClick={() => setEdit("new")} disabled={mutation.waiting}>
                <HugeiconsIcon icon={Add01Icon} size={16} />
                Create group
              </Button>
            )}
          </div>
          {filtered.length ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filtered.map((group) => (
                <Link
                  key={group.id}
                  to="/org/$organizationSlug/groups/$groupId"
                  params={{ organizationSlug, groupId: group.id }}
                  className="flex min-h-40 flex-col rounded-lg border p-5 transition-colors hover:border-input hover:bg-muted"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex size-9 items-center justify-center rounded-lg border bg-muted">
                      <HugeiconsIcon icon={UserGroupIcon} size={18} />
                    </span>
                    <h2 className="min-w-0 break-words text-sm font-medium">{group.name}</h2>
                  </div>
                  {group.description && (
                    <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                      {group.description}
                    </p>
                  )}
                  <div className="mt-auto flex items-center justify-between pt-5">
                    <div className="flex -space-x-2">
                      {data.members
                        .filter((member) => group.memberIds.includes(member.id))
                        .slice(0, 4)
                        .map((member) => (
                          <MemberAvatar key={member.id} member={member} />
                        ))}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {group.memberIds.length} {group.memberIds.length === 1 ? "member" : "members"}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState title={search ? "No matching groups" : "No groups yet"}>
              {search
                ? "Try another name."
                : admin
                  ? "Create a group and choose its members."
                  : "An organization admin can create groups."}
            </EmptyState>
          )}
        </>
      )}
      {edit && (
        <GroupEditor
          key={edit === "new" ? "new" : edit.id}
          group={edit === "new" ? null : edit}
          members={data.members}
          close={() => setEdit(null)}
        />
      )}
      {removing && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !deletion.waiting) setRemoving(null);
          }}
        >
          <DialogContent>
            <DialogTitle>Delete {removing.name}?</DialogTitle>
            <DialogDescription>
              This removes the group and its membership list. People remain in the organization.
            </DialogDescription>
            {removeError && <HostedFailure cause={removeError} />}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={deletion.waiting}
                onClick={() => setRemoving(null)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={deletion.waiting}
                onClick={async () => {
                  setRemoveError(undefined);
                  const result = await remove(removing);
                  if (Exit.isFailure(result)) setRemoveError(result.cause);
                  else {
                    setRemoving(null);
                    await navigate({
                      to: "/org/$organizationSlug/groups",
                      params: { organizationSlug },
                    });
                  }
                }}
              >
                Delete group
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
function MemberAvatar({ member }: { readonly member: GroupMember }) {
  return (
    <Avatar className="size-8 shrink-0 border-2 border-background">
      <AvatarFallback className="bg-accent text-[10px]">
        {member.name
          .split(/\s+/)
          .slice(0, 2)
          .map((part) => part.slice(0, 1))
          .join("")
          .toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
function Members({ members }: { readonly members: readonly GroupMember[] }) {
  return members.length ? (
    <div className="divide-y rounded-lg border">
      {members.map((member) => (
        <div key={member.id} className="flex items-center gap-3 p-4">
          <MemberAvatar member={member} />
          <div className="min-w-0">
            <p className="text-sm font-medium">{member.name}</p>
            <p className="break-words text-xs text-muted-foreground">{member.email}</p>
          </div>
        </div>
      ))}
    </div>
  ) : (
    <EmptyState title="No members yet">No members in this group.</EmptyState>
  );
}
function GroupEditor({
  group,
  members,
  close,
}: {
  readonly group: Group | null;
  readonly members: readonly GroupMember[];
  readonly close: () => void;
}) {
  const { organization } = useOrganizationRoute();
  const latest = useAtomValue(groupsAtom(organization));
  const refresh = useAtomRefresh(groupsAtom(organization));
  const [search, setSearch] = useState("");
  const save = useAtomSet(saveGroupAtom(organization), { mode: "promiseExit" });
  const id = useId();
  const element = useRef<HTMLFormElement>(null);
  const focusFailure = useRef(false);
  const form = useForm({
    defaultValues: {
      name: group?.name ?? "",
      description: group?.description ?? "",
      memberIds: group?.memberIds ?? [],
    },
    onSubmitInvalid: () => {
      focusFailure.current = true;
    },
    onSubmit: async ({ value, formApi }) => {
      const result = await save({
        existing: group,
        input: { ...value, name: value.name.trim(), description: value.description.trim() },
      });
      if (Exit.isSuccess(result)) {
        close();
        return;
      }
      const error = Cause.findErrorOption(result.cause);
      const nameTaken =
        Option.isSome(error) &&
        error.value instanceof GroupConflict &&
        error.value.reason === "name_taken";
      formApi.setErrorMap({
        onSubmit: nameTaken
          ? { fields: { name: appError(result.cause) } }
          : { form: appError(result.cause), fields: {} },
      });
      focusFailure.current = true;
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);
  const attempts = useStore(form.store, (state) => state.submissionAttempts);
  const error = useStore(form.store, (state) => state.errorMap.onSubmit);
  useEffect(() => {
    if (submitting || !focusFailure.current) return;
    focusFailure.current = false;
    // Wait for enabled controls and their accessible errors to render before focusing.
    element.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"], [data-submit-error]')
      ?.focus();
  }, [submitting, attempts]);
  const shown = members.filter((member) =>
    `${member.name} ${member.email}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) close();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogTitle>{group ? "Edit group" : "Create group"}</DialogTitle>
        <DialogDescription>Choose from existing organization members.</DialogDescription>
        <form
          ref={element}
          noValidate
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (submitting) return;
            // A server failure belongs to the previous attempt, not the next validation.
            form.setErrorMap({ onSubmit: { fields: {} } });
            await form.handleSubmit();
          }}
        >
          {typeof error === "string" && (
            <Alert
              data-submit-error
              tabIndex={-1}
              variant="destructive"
              className="border-destructive/50 bg-destructive/10 focus-visible:ring-2 focus-visible:ring-destructive outline-none"
            >
              <HugeiconsIcon icon={AlertCircleIcon} size={18} />
              <AlertTitle>{group ? "Could not save group" : "Could not create group"}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <form.Field
            name="name"
            validators={{
              onChange: ({ value }) =>
                !value.trim()
                  ? "Enter a group name."
                  : value.trim().length > 80
                    ? "Use 80 characters or fewer."
                    : undefined,
            }}
          >
            {(field) => {
              const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
              return (
                <div>
                  <label htmlFor={`${id}-name`} className="block text-xs font-medium">
                    Group name
                  </label>
                  <Input
                    id={`${id}-name`}
                    name={field.name}
                    required
                    maxLength={80}
                    value={field.state.value}
                    disabled={submitting}
                    className="mt-2"
                    placeholder="Engineering"
                    aria-invalid={invalid}
                    aria-describedby={invalid ? `${id}-name-error` : undefined}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  {invalid && (
                    <p
                      id={`${id}-name-error`}
                      role="alert"
                      className="mt-2 flex items-start gap-1.5 text-sm font-medium text-destructive"
                    >
                      <HugeiconsIcon icon={AlertCircleIcon} size={16} className="mt-0.5 shrink-0" />
                      {field.state.meta.errors
                        .filter((message) => typeof message === "string")
                        .join(" ")}
                    </p>
                  )}
                </div>
              );
            }}
          </form.Field>
          <form.Field
            name="description"
            validators={{
              onChange: ({ value }) =>
                value.length > 240 ? "Use 240 characters or fewer." : undefined,
            }}
          >
            {(field) => {
              const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
              return (
                <div>
                  <label htmlFor={`${id}-description`} className="block text-xs font-medium">
                    Description{" "}
                    <span className="font-normal text-muted-foreground">(optional)</span>
                  </label>
                  <Input
                    id={`${id}-description`}
                    name={field.name}
                    maxLength={240}
                    value={field.state.value}
                    disabled={submitting}
                    className="mt-2"
                    onBlur={field.handleBlur}
                    aria-invalid={invalid}
                    aria-describedby={invalid ? `${id}-description-error` : undefined}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  {invalid && (
                    <p
                      id={`${id}-description-error`}
                      role="alert"
                      className="mt-2 text-sm font-medium text-destructive"
                    >
                      {field.state.meta.errors
                        .filter((message) => typeof message === "string")
                        .join(" ")}
                    </p>
                  )}
                </div>
              );
            }}
          </form.Field>
          <form.Field name="memberIds">
            {(field) => (
              <fieldset disabled={submitting} className="space-y-2">
                <legend className="mb-2 text-xs font-medium">
                  Members · {field.state.value.length} selected
                </legend>
                <Input
                  aria-label="Search organization members"
                  placeholder="Search members…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <div className="max-h-64 overflow-y-auto rounded-lg border">
                  {shown.map((member) => (
                    <label
                      key={member.id}
                      className="flex cursor-pointer items-center gap-3 border-b px-3 py-2.5 last:border-0"
                    >
                      <MemberAvatar member={member} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm">{member.name}</span>
                        <span className="block break-words text-xs text-muted-foreground">
                          {member.email}
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-foreground"
                        aria-label={`Include ${member.email}`}
                        checked={field.state.value.includes(member.id)}
                        onBlur={field.handleBlur}
                        onChange={(event) =>
                          field.handleChange(
                            event.target.checked
                              ? [...field.state.value, member.id]
                              : field.state.value.filter((id) => id !== member.id),
                          )
                        }
                      />
                    </label>
                  ))}
                  {!shown.length && (
                    <EmptyState size="compact" icon={null} title="No matching members">
                      Try another name or email.
                    </EmptyState>
                  )}
                </div>
              </fieldset>
            )}
          </form.Field>
          {AsyncResult.isFailure(latest) && <HostedFailure cause={latest.cause} retry={refresh} />}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={submitting} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              {group ? "Save group" : "Create group"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GroupApps({ group }: { readonly group: string }) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  return (
    <section className="mt-7 space-y-3">
      <h3 className="text-sm font-medium">Apps</h3>
      <QueryView query={resourceDirectoryAtom(organization)} Failure={HostedFailure}>
        {(data) => {
          const apps = data.apps.filter(
            ({ access }) =>
              access.audience.kind === "everyone" ||
              (access.audience.kind === "groups" &&
                access.audience.groups.some((id) => id === group)),
          );
          return apps.length ? (
            <div className="divide-y rounded-lg border">
              {apps.map(({ app }) => (
                <Link
                  className="block p-4 text-sm hover:bg-muted"
                  key={app.id}
                  to="/org/$organizationSlug/apps/$appId"
                  params={{ organizationSlug, appId: app.id }}
                >
                  {app.name}
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState title="No apps available">
              No apps are available to you in this group.
            </EmptyState>
          );
        }}
      </QueryView>
    </section>
  );
}
