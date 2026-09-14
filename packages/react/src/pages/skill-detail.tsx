import { useMemo } from "react";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import { toast } from "sonner";
import {
  parseSkillMarkdown,
  skillFileUri,
  SKILL_MD_PATH,
  type Owner,
  type SkillName,
} from "@executor-js/sdk/shared";

import { removeSkill, skillAtom } from "../api/atoms";
import { messageFromExit } from "../api/error-reporting";
import { skillWriteKeys } from "../api/reactivity-keys";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/alert-dialog";
import { Button } from "../components/button";
import { CopyButton } from "../components/copy-button";
import { ErrorState } from "../components/error-state";
import { Markdown } from "../components/markdown";
import { PageContainer, PageHeader } from "../components/page";
import { isAsyncResultLoading } from "../lib/async-result";
import { useExecutorDocumentTitle } from "../lib/document-title";
import { formatRelativeTime } from "../lib/relative-time";
import { SkillOwnerTag } from "./skills";

interface SkillFileRow {
  readonly path: string;
  readonly size: number;
  readonly digest: string;
  readonly content: string;
}

const BackLink = () => (
  <Button asChild variant="ghost" size="sm" className="-ml-3 mb-4 text-muted-foreground">
    <Link to="/{-$orgSlug}/skills">Skills</Link>
  </Button>
);

/** A URL that names no skill this host could ever have (a bad owner segment). */
export function SkillMissingPage() {
  useExecutorDocumentTitle("Skill");
  return (
    <PageContainer>
      <BackLink />
      <p className="text-sm text-muted-foreground">
        That isn&apos;t a skill address. A skill lives at{" "}
        <span className="font-mono text-foreground">/skills/user/&lt;name&gt;</span> or{" "}
        <span className="font-mono text-foreground">/skills/org/&lt;name&gt;</span>.
      </p>
    </PageContainer>
  );
}

/** A labelled row of machine metadata — mono value, quiet mono key. */
function MetaRow(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex gap-4 py-2">
      <dt className="w-40 shrink-0 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
        {props.label}
      </dt>
      <dd className="min-w-0 flex-1 text-sm text-foreground">{props.children}</dd>
    </div>
  );
}

/** One bundled file: path and size always visible, content behind a disclosure
 *  so a skill with a dozen references still reads as a list. */
function SkillFileEntry(props: { readonly file: SkillFileRow }) {
  const { file } = props;
  return (
    <details className="group/skill-file px-4 py-2.5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 outline-none focus-visible:underline">
        <span className="truncate font-mono text-[13px] text-foreground">{file.path}</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {file.size} B
        </span>
      </summary>
      <pre className="mt-2.5 max-h-96 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-foreground">
        {file.content}
      </pre>
    </details>
  );
}

/**
 * What an agent gets. The console is where a person decides whether a skill is
 * doing its job, and they cannot judge that without seeing the two addresses
 * their agent will actually use.
 */
function AgentAddressing(props: { readonly owner: Owner; readonly name: string }) {
  const toolCall = `skills({ name: "${props.name}" })`;
  const uri = skillFileUri({ owner: props.owner, name: props.name }, SKILL_MD_PATH);
  return (
    <section>
      <h2 className="mb-3 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        Agents see this as
      </h2>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {[toolCall, uri].map((value) => (
          <div key={value} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <code className="truncate font-mono text-[12px] text-foreground">{value}</code>
            <CopyButton value={value} />
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        The tool call works on every MCP client today. The{" "}
        <span className="font-mono">skill://</span> resource is for clients that speak the MCP
        Skills extension.
      </p>
    </section>
  );
}

export function SkillDetailPage(props: { readonly owner: Owner; readonly name: SkillName }) {
  // Rebuilt every render, so it MUST go through the atom family — see
  // `skillAtom`. `useMemo` keeps the key object stable for the hook deps too.
  const ref = useMemo(() => ({ owner: props.owner, name: props.name }), [props.owner, props.name]);
  const skill = useAtomValue(skillAtom(ref));
  const refresh = useAtomRefresh(skillAtom(ref));
  const doRemove = useAtomSet(removeSkill, { mode: "promiseExit" });
  const navigate = useNavigate();

  useExecutorDocumentTitle(props.name || "Skill");

  const handleRemove = async () => {
    const exit = await doRemove({ params: ref, reactivityKeys: skillWriteKeys });
    if (Exit.isFailure(exit)) {
      toast.error(messageFromExit(exit, "Couldn't delete the skill. Try again."));
      return;
    }
    toast.success("Skill deleted");
    // `params` is omitted so the router keeps the active org slug.
    await navigate({ to: "/{-$orgSlug}/skills" });
  };

  return (
    <PageContainer>
      <BackLink />

      {isAsyncResultLoading(skill) ? (
        <p className="text-sm text-muted-foreground">Loading skill…</p>
      ) : (
        AsyncResult.match(skill, {
          onInitial: () => <p className="text-sm text-muted-foreground">Loading skill…</p>,
          onFailure: () => (
            <ErrorState
              message="This skill isn't available. It may have been deleted."
              onRetry={refresh}
            />
          ),
          onSuccess: ({ value }) => {
            const files = value.files as ReadonlyArray<SkillFileRow>;
            const skillMd = files.find((file) => file.path === SKILL_MD_PATH);
            const parsed = skillMd ? parseSkillMarkdown(skillMd.content) : undefined;
            const body =
              parsed && Result.isSuccess(parsed) ? parsed.success.body : (skillMd?.content ?? "");
            // Name and description have their own place in the header; the rest
            // of the frontmatter is whatever the author wrote and is shown
            // verbatim, because that is what the MCP host hands to agents.
            const extraFrontmatter = Object.entries(value.frontmatter).filter(
              ([key]) => key !== "name" && key !== "description",
            );

            return (
              <div className="space-y-10">
                <PageHeader
                  className="mb-0"
                  title={<span className="font-mono text-[1.6rem]">{value.name}</span>}
                  description={value.description}
                  actions={
                    <>
                      <Button asChild variant="outline" size="sm">
                        <Link
                          to="/{-$orgSlug}/skills/$skillOwner/$skillName"
                          params={{ skillOwner: value.owner, skillName: value.name }}
                          search={{ edit: true }}
                        >
                          Edit
                        </Link>
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="text-muted-foreground hover:text-destructive"
                          >
                            Delete
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent size="sm">
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete {value.name}?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This removes the skill and every file in it. Agents will no longer
                              find it by name.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              variant="destructive"
                              onClick={() => void handleRemove()}
                            >
                              Delete Skill
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </>
                  }
                >
                  <div className="mt-3 flex items-center gap-2">
                    <SkillOwnerTag owner={value.owner} />
                    <span className="font-mono text-[11px] text-muted-foreground">
                      Updated {formatRelativeTime(value.updatedAt)}
                    </span>
                  </div>
                </PageHeader>

                {extraFrontmatter.length > 0 ? (
                  <section>
                    <h2 className="mb-1 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      Frontmatter
                    </h2>
                    <dl className="divide-y divide-border">
                      {extraFrontmatter.map(([key, fieldValue]) => (
                        <MetaRow key={key} label={key}>
                          <span className="font-mono text-[12px] break-words">
                            {typeof fieldValue === "string"
                              ? fieldValue
                              : JSON.stringify(fieldValue)}
                          </span>
                        </MetaRow>
                      ))}
                    </dl>
                  </section>
                ) : null}

                <section>
                  <h2 className="mb-3 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    Instructions
                  </h2>
                  <div className="rounded-lg border border-border bg-card px-5 py-4 text-sm leading-relaxed">
                    <Markdown>{body}</Markdown>
                  </div>
                </section>

                <section>
                  <h2 className="mb-3 flex items-center font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    Files
                    <span className="ml-2 font-normal tabular-nums">{files.length}</span>
                  </h2>
                  <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                    {files.map((file) => (
                      <SkillFileEntry key={file.path} file={file} />
                    ))}
                  </div>
                </section>

                <AgentAddressing owner={value.owner} name={value.name} />
              </div>
            );
          },
        })
      )}
    </PageContainer>
  );
}
