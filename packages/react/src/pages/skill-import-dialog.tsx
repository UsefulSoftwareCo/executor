import { useState } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Owner } from "@executor-js/sdk/shared";

import { importSkills, saveSkill } from "../api/atoms";
import { messageFromExit } from "../api/error-reporting";
import { useOrganizationId } from "../api/organization-context";
import { skillWriteKeys } from "../api/reactivity-keys";
import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/dialog";
import { FieldLabel } from "../components/field";
import { Input } from "../components/input";
import { Label } from "../components/label";
import { FormErrorAlert } from "../lib/integration-add";
import { useCanCreateWorkspaceConnections } from "../multiplayer/use-admin-nav";
import {
  ConnectionOwnerDropdown,
  connectionOwnerOptionsForAccess,
  defaultConnectionOwnerForHost,
  normalizeConnectionOwner,
} from "../plugins/connection-owner";

// ---------------------------------------------------------------------------
// Import skills from a GitHub repository (or a skills.sh link, which is one).
//
// Two steps in one dialog. First the server lists every skill it found at the
// URL — already validated, so each row shows the real name and description.
// Then the user ticks the ones to keep and picks the owner, and each is saved
// through the same endpoint the editor uses. Nothing is written until Save.
// ---------------------------------------------------------------------------

const ErrorReason = Schema.Struct({ reason: Schema.String });
const decodeReason = Schema.decodeUnknownOption(ErrorReason);

const reasonFromExit = (exit: Exit.Exit<unknown, unknown>, fallback: string): string =>
  Option.match(Option.flatMap(Exit.findErrorOption(exit), decodeReason), {
    onNone: () => messageFromExit(exit, fallback),
    onSome: ({ reason }) => reason,
  });

interface Candidate {
  readonly directory: string;
  readonly name: string;
  readonly description: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
}

interface Found {
  readonly source: string;
  readonly ref: string;
  readonly skills: readonly Candidate[];
  readonly rejected: ReadonlyArray<{ readonly directory: string; readonly reason: string }>;
  readonly truncated: boolean;
}

export function SkillImportDialog(props: {
  readonly onClose: () => void;
  /** Called once per saved skill, after the whole batch succeeded. */
  readonly onImported: (saved: ReadonlyArray<{ owner: Owner; name: string }>) => void;
}) {
  const organizationId = useOrganizationId();
  const canCreateWorkspace = useCanCreateWorkspaceConnections();
  const ownerOptions = connectionOwnerOptionsForAccess(organizationId, canCreateWorkspace);

  const [source, setSource] = useState("");
  const [owner, setOwner] = useState<Owner>(defaultConnectionOwnerForHost(organizationId));
  const [found, setFound] = useState<Found | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<"idle" | "finding" | "saving">("idle");
  const [error, setError] = useState<string | null>(null);

  const doImport = useAtomSet(importSkills, { mode: "promiseExit" });
  const doSave = useAtomSet(saveSkill, { mode: "promiseExit" });
  const activeOwner = normalizeConnectionOwner(owner, ownerOptions);

  const find = async () => {
    if (source.trim() === "" || busy !== "idle") return;
    setBusy("finding");
    setError(null);
    setFound(null);
    const exit = await doImport({ payload: { source }, reactivityKeys: [] });
    setBusy("idle");
    if (Exit.isFailure(exit)) {
      setError(reasonFromExit(exit, "Couldn't reach that repository. Try again."));
      return;
    }
    setFound(exit.value);
    // Everything valid starts ticked: the common case is "take all of these".
    setPicked(new Set(exit.value.skills.map((skill) => skill.directory)));
  };

  const toggle = (directory: string, on: boolean) => {
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(directory);
      else next.delete(directory);
      return next;
    });
  };

  const save = async () => {
    if (!found || busy !== "idle") return;
    const chosen = found.skills.filter((skill) => picked.has(skill.directory));
    if (chosen.length === 0) return;
    setBusy("saving");
    setError(null);
    const saved: Array<{ owner: Owner; name: string }> = [];
    for (const skill of chosen) {
      const exit = await doSave({
        payload: { owner: activeOwner, files: skill.files },
        reactivityKeys: skillWriteKeys,
      });
      if (Exit.isFailure(exit)) {
        setBusy("idle");
        setError(
          `${saved.length} of ${chosen.length} saved. \`${skill.name}\` failed: ${reasonFromExit(exit, "the save did not complete.")}`,
        );
        if (saved.length > 0) props.onImported(saved);
        return;
      }
      saved.push({ owner: activeOwner, name: exit.value.name });
    }
    setBusy("idle");
    props.onImported(saved);
    props.onClose();
  };

  const pickedCount = found ? found.skills.filter((s) => picked.has(s.directory)).length : 0;

  return (
    <Dialog open onOpenChange={(open: boolean) => (open ? undefined : props.onClose())}>
      <DialogContent dismissOnOutsideClick={busy === "idle"} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Import from GitHub</DialogTitle>
          <DialogDescription>
            Paste a repository, a folder inside one, a skills.sh link, or the{" "}
            <span className="font-mono">npx skills add …</span> command a skill page shows. Every
            SKILL.md found there is listed; pick the ones to save.
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-5">
          {error ? <FormErrorAlert message={error} /> : null}

          <div className="space-y-1.5">
            <FieldLabel className="text-[11px]">Source</FieldLabel>
            <div className="flex gap-2">
              <Input
                value={source}
                autoFocus
                spellCheck={false}
                placeholder="owner/repo, a github.com URL, or npx skills add … --skill name"
                className="font-mono text-[12px]"
                onChange={(event) => setSource(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void find();
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== "idle" || source.trim() === ""}
                onClick={() => void find()}
              >
                {busy === "finding" ? "Finding…" : "Find Skills"}
              </Button>
            </div>
          </div>

          {found ? (
            <div className="min-w-0 space-y-4">
              <div className="flex items-baseline justify-between">
                <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Found in {found.source}
                  <span className="ml-2 font-normal tabular-nums">{found.skills.length}</span>
                </h3>
                <span className="font-mono text-[11px] text-muted-foreground">@{found.ref}</span>
              </div>

              {found.skills.length > 0 ? (
                <ul className="max-h-72 min-w-0 divide-y divide-border overflow-auto rounded-lg border border-border bg-card">
                  {found.skills.map((skill) => {
                    const id = `import-${skill.directory || "root"}`;
                    return (
                      <li
                        key={skill.directory}
                        className="flex min-w-0 items-start gap-3 px-3 py-2.5"
                      >
                        <Checkbox
                          id={id}
                          checked={picked.has(skill.directory)}
                          onCheckedChange={(state) => toggle(skill.directory, state === true)}
                          className="mt-0.5"
                        />
                        <Label
                          htmlFor={id}
                          className="min-w-0 flex-1 cursor-pointer flex-col items-start gap-0"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-mono text-sm text-foreground">
                              {skill.name}
                            </span>
                            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                              {skill.files.length} {skill.files.length === 1 ? "file" : "files"}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">
                            {skill.description}
                          </span>
                          {skill.directory ? (
                            <span className="mt-0.5 block truncate font-mono text-[11px] font-normal text-muted-foreground/70">
                              {skill.directory}
                            </span>
                          ) : null}
                        </Label>
                      </li>
                    );
                  })}
                </ul>
              ) : null}

              {found.rejected.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Skipped {found.rejected.length} with an invalid SKILL.md:{" "}
                  {found.rejected
                    .slice(0, 3)
                    .map((entry) => `${entry.directory || "(root)"} — ${entry.reason}`)
                    .join("; ")}
                  {found.rejected.length > 3 ? "…" : ""}
                </p>
              ) : null}
              {found.truncated ? (
                <p className="text-xs text-muted-foreground">
                  Only the first {found.skills.length + found.rejected.length} skills were read.
                  Import a narrower path for the rest.
                </p>
              ) : null}

              <ConnectionOwnerDropdown
                value={activeOwner}
                options={ownerOptions}
                onChange={setOwner}
                label="Save as"
                className="max-w-xs space-y-1.5"
              />
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={props.onClose}
            disabled={busy === "saving"}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!found || pickedCount === 0 || busy !== "idle"}
            onClick={() => void save()}
          >
            {busy === "saving"
              ? "Saving…"
              : pickedCount > 0
                ? `Save ${pickedCount} ${pickedCount === 1 ? "Skill" : "Skills"}`
                : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
