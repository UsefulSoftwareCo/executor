import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  isValidSkillFilePath,
  parseSkillMarkdown,
  SKILL_MD_PATH,
  type Owner,
  type SkillName,
} from "@executor-js/sdk/shared";

import { saveSkill, skillAtom } from "../api/atoms";
import { messageFromExit } from "../api/error-reporting";
import { useOrganizationId } from "../api/organization-context";
import { skillWriteKeys } from "../api/reactivity-keys";
import { Button } from "../components/button";
import { FieldLabel } from "../components/field";
import { Input } from "../components/input";
import { PageContainer, PageHeader } from "../components/page";
import { Textarea } from "../components/textarea";
import { FormErrorAlert } from "../lib/integration-add";
import { useExecutorDocumentTitle } from "../lib/document-title";
import {
  connectionOwnerOptionsForAccess,
  ConnectionOwnerDropdown,
  defaultConnectionOwnerForHost,
  normalizeConnectionOwner,
} from "../plugins/connection-owner";
import { useCanCreateWorkspaceConnections } from "../multiplayer/use-admin-nav";

/** A skill that already parses, so the validation panel is green from the first
 *  keystroke and the author edits a working example instead of guessing. */
const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when an agent should load it.
---

# My skill

Write the instructions an agent should follow here.

## Steps

1. ...
`;

/** Files above this are almost never instructions, and the whole skill is
 *  capped at 1 MiB anyway — better to say which file was dropped than to fail
 *  the save with a total-size error. */
const MAX_IMPORT_FILE_BYTES = 512 * 1024;

const SkillErrorReason = Schema.Struct({ reason: Schema.String });
const decodeReason = Schema.decodeUnknownOption(SkillErrorReason);

/** `InvalidSkillError` carries the actionable sentence in `reason`; its
 *  `message` prefixes it with "Invalid skill:", which the alert's placement
 *  already says. Everything else (org-write denied, transport) uses `message`. */
const saveErrorMessage = (exit: Exit.Exit<unknown, unknown>): string =>
  Option.match(Option.flatMap(Exit.findErrorOption(exit), decodeReason), {
    onNone: () => messageFromExit(exit, "Couldn't save the skill. Try again."),
    onSome: ({ reason }) => reason,
  });

interface ExtraFileRow {
  /** Stable across edits so a row keeps focus while its path is retyped. */
  readonly id: number;
  readonly path: string;
  readonly content: string;
}

interface EditorSeed {
  readonly owner: Owner | null;
  readonly skillMd: string;
  readonly extras: readonly ExtraFileRow[];
  /** The `(owner, name)` this editor opened, when it is editing one. */
  readonly original: { readonly owner: Owner; readonly name: string } | null;
}

export function SkillEditorPage(props: {
  readonly editing?: { readonly owner: Owner; readonly name: SkillName } | undefined;
}) {
  if (props.editing === undefined) {
    return (
      <SkillEditorForm
        seed={{ owner: null, skillMd: NEW_SKILL_TEMPLATE, extras: [], original: null }}
      />
    );
  }
  return <SkillEditorLoader editing={props.editing} />;
}

/** Editing needs the stored file CONTENTS, which only `skills.get` returns. The
 *  form is mounted once the row lands so its state can be seeded directly,
 *  rather than syncing an effect against a changing fetch. */
function SkillEditorLoader(props: {
  readonly editing: { readonly owner: Owner; readonly name: SkillName };
}) {
  const ref = useMemo(
    () => ({ owner: props.editing.owner, name: props.editing.name }),
    [props.editing.owner, props.editing.name],
  );
  const skill = useAtomValue(skillAtom(ref));

  if (!AsyncResult.isSuccess(skill)) {
    return (
      <PageContainer>
        <p className="text-sm text-muted-foreground">
          {AsyncResult.isFailure(skill) ? "This skill isn't available." : "Loading skill…"}
        </p>
      </PageContainer>
    );
  }

  const files = skill.value.files as ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  const skillMd = files.find((file) => file.path === SKILL_MD_PATH);
  return (
    <SkillEditorForm
      seed={{
        owner: skill.value.owner,
        skillMd: skillMd?.content ?? NEW_SKILL_TEMPLATE,
        extras: files
          .filter((file) => file.path !== SKILL_MD_PATH)
          .map((file, index) => ({ id: index, path: file.path, content: file.content })),
        original: { owner: skill.value.owner, name: skill.value.name },
      }}
    />
  );
}

function SkillEditorForm(props: { readonly seed: EditorSeed }) {
  const { seed } = props;
  const editing = seed.original !== null;
  useExecutorDocumentTitle(editing ? `Edit ${seed.original?.name ?? ""}` : "New skill");

  const organizationId = useOrganizationId();
  const canCreateWorkspaceConnections = useCanCreateWorkspaceConnections();
  const ownerOptions = connectionOwnerOptionsForAccess(
    organizationId,
    canCreateWorkspaceConnections,
  );
  const [owner, setOwner] = useState<Owner>(
    seed.owner ?? defaultConnectionOwnerForHost(organizationId),
  );
  const [skillMd, setSkillMd] = useState(seed.skillMd);
  const [extras, setExtras] = useState<readonly ExtraFileRow[]>(seed.extras);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const nextRowId = useRef(seed.extras.length);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();

  // `webkitdirectory` is what turns a file input into a folder picker. React's
  // typings don't declare it, so it is set on the element rather than in JSX.
  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);

  // Always keep the selection valid against the options this host offers — on
  // local there is exactly one, and the picker hides itself.
  const activeOwner = normalizeConnectionOwner(owner, ownerOptions);
  const parsed = useMemo(() => parseSkillMarkdown(skillMd), [skillMd]);
  const parsedName = Result.isSuccess(parsed) ? parsed.success.name : null;
  // Identity is `(owner, name)` and `save` reads the name out of the file, so
  // retitling the frontmatter or moving the owner writes a SECOND skill and
  // leaves this one alone. Say that before the save, not after.
  const forksExisting =
    seed.original !== null &&
    parsedName !== null &&
    (parsedName !== seed.original.name || activeOwner !== seed.original.owner);

  const doSave = useAtomSet(saveSkill, { mode: "promiseExit" });

  const addRow = () => {
    setExtras((rows) => [...rows, { id: nextRowId.current++, path: "", content: "" }]);
  };

  const updateRow = (id: number, patch: Partial<Omit<ExtraFileRow, "id">>) => {
    setExtras((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const removeRow = (id: number) => {
    setExtras((rows) => rows.filter((row) => row.id !== id));
  };

  /**
   * Read a picked folder into the editor.
   *
   * A folder pick reports every file as `<folder>/<path>`, so the wrapping
   * segment is stripped — otherwise SKILL.md would land at `my-skill/SKILL.md`
   * and the save would reject a skill with no root file. Binary and oversized
   * files are dropped rather than mangled into UTF-8, and dotfiles go with them
   * (`.DS_Store` is in every folder a Mac has ever opened).
   */
  const importFolder = async (picked: FileList) => {
    const chosen = Array.from(picked);
    const relative = chosen.map((file) => file.webkitRelativePath || file.name);
    const topSegments = new Set(relative.map((path) => path.split("/")[0]));
    const strip = topSegments.size === 1 && relative.every((path) => path.includes("/"));

    const imported: Array<{ path: string; content: string }> = [];
    const skipped: string[] = [];
    for (const [index, file] of chosen.entries()) {
      const raw = relative[index] ?? file.name;
      const path = strip ? raw.split("/").slice(1).join("/") : raw;
      if (
        path === "" ||
        !isValidSkillFilePath(path) ||
        path.split("/").some((segment) => segment.startsWith(".")) ||
        file.size > MAX_IMPORT_FILE_BYTES
      ) {
        skipped.push(raw);
        continue;
      }
      const content = await file.text();
      // A NUL byte is the cheap, reliable tell that this was never text.
      if (content.includes("\u0000")) {
        skipped.push(raw);
        continue;
      }
      imported.push({ path, content });
    }

    const rootFile = imported.find((file) => file.path === SKILL_MD_PATH);
    if (rootFile) setSkillMd(rootFile.content);
    setExtras(
      imported
        .filter((file) => file.path !== SKILL_MD_PATH)
        .map((file) => ({ id: nextRowId.current++, path: file.path, content: file.content })),
    );

    const parts = [`Imported ${imported.length} ${imported.length === 1 ? "file" : "files"}.`];
    if (!rootFile) parts.push("No SKILL.md in that folder — write one below.");
    if (skipped.length > 0) {
      parts.push(
        `Skipped ${skipped.length} (binary, hidden, or over 512 KiB): ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}.`,
      );
    }
    setImportNotice(parts.join(" "));
  };

  const submit = async () => {
    if (!Result.isSuccess(parsed) || saving) return;
    setSaving(true);
    setError(null);
    const exit = await doSave({
      payload: {
        owner: activeOwner,
        files: [
          { path: SKILL_MD_PATH, content: skillMd },
          ...extras
            .filter((row) => row.path.trim() !== "")
            .map((row) => ({ path: row.path.trim(), content: row.content })),
        ],
      },
      reactivityKeys: skillWriteKeys,
    });
    setSaving(false);
    if (Exit.isFailure(exit)) {
      setError(saveErrorMessage(exit));
      return;
    }
    // `params` names the saved row, not the one the editor opened — the save
    // may have written a different name than the URL carried.
    await navigate({
      to: "/{-$orgSlug}/skills/$skillOwner/$skillName",
      params: { skillOwner: exit.value.owner, skillName: exit.value.name },
      search: {},
    });
  };

  return (
    <PageContainer>
      <Button asChild variant="ghost" size="sm" className="-ml-3 mb-4 text-muted-foreground">
        <Link to="/{-$orgSlug}/skills">Skills</Link>
      </Button>

      <PageHeader
        title={editing ? "Edit skill" : "New skill"}
        description={
          editing
            ? "Change the instructions or the files that travel with them. Agents pick the new version up on their next load."
            : "Write a SKILL.md, or import a folder you already have. Every agent connected to this workspace can load it by name."
        }
        actions={
          <Button
            type="button"
            size="sm"
            loading={saving}
            disabled={!Result.isSuccess(parsed)}
            onClick={() => void submit()}
          >
            Save Skill
          </Button>
        }
      />

      <div className="space-y-8">
        {error ? <FormErrorAlert message={error} /> : null}

        <ConnectionOwnerDropdown
          value={activeOwner}
          options={ownerOptions}
          onChange={setOwner}
          label="Shared with"
          help="Personal skills are yours alone. Workspace skills load for every agent in this workspace."
          className="max-w-xs space-y-1.5"
        />

        <section className="space-y-2">
          <div className="flex items-end justify-between gap-3">
            <div>
              <FieldLabel className="text-[11px]">SKILL.md</FieldLabel>
              <p className="mt-1 text-xs text-muted-foreground">
                YAML frontmatter with <span className="font-mono">name</span> and{" "}
                <span className="font-mono">description</span>, then the instructions.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => folderInput.current?.click()}
            >
              Import Folder
            </Button>
            <Input
              ref={folderInput}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                const picked = event.target.files;
                if (picked && picked.length > 0) void importFolder(picked);
                // Clear it so picking the SAME folder again still fires.
                event.target.value = "";
              }}
            />
          </div>
          {importNotice ? <p className="text-xs text-muted-foreground">{importNotice}</p> : null}
          <Textarea
            value={skillMd}
            spellCheck={false}
            onChange={(event) => setSkillMd(event.target.value)}
            className="min-h-96 font-mono text-[12px] leading-relaxed"
            aria-label="SKILL.md"
          />
          <ValidationPanel parsed={parsed} forksExisting={forksExisting} original={seed.original} />
        </section>

        <section className="space-y-2">
          <div className="flex items-end justify-between gap-3">
            <div>
              <FieldLabel className="text-[11px]">Additional files</FieldLabel>
              <p className="mt-1 text-xs text-muted-foreground">
                References and scripts the instructions point at, by relative path.
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={addRow}>
              Add File
            </Button>
          </div>
          {extras.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
              No additional files. A SKILL.md on its own is a complete skill.
            </p>
          ) : (
            <ul className="space-y-3">
              {extras.map((row) => (
                <li key={row.id} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      value={row.path}
                      spellCheck={false}
                      placeholder="references/api.md"
                      onChange={(event) => updateRow(row.id, { path: event.target.value })}
                      className="font-mono text-[12px]"
                      aria-label="File path"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => removeRow(row.id)}
                    >
                      Remove
                    </Button>
                  </div>
                  <Textarea
                    value={row.content}
                    spellCheck={false}
                    onChange={(event) => updateRow(row.id, { content: event.target.value })}
                    className="mt-2 min-h-32 font-mono text-[12px] leading-relaxed"
                    aria-label={`Contents of ${row.path || "file"}`}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </PageContainer>
  );
}

/** What the server will read out of the file, shown while it is being typed —
 *  the frontmatter is the only part of a SKILL.md with rules, and finding out
 *  it is wrong at save time is the slowest possible way to learn it. */
function ValidationPanel(props: {
  readonly parsed: ReturnType<typeof parseSkillMarkdown>;
  readonly forksExisting: boolean;
  readonly original: { readonly owner: Owner; readonly name: string } | null;
}) {
  if (Result.isFailure(props.parsed)) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
        <p className="text-[12px] text-destructive">{props.parsed.failure.reason}</p>
      </div>
    );
  }
  const { name, description } = props.parsed.success;
  return (
    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
      <dl className="space-y-1">
        <div className="flex gap-3">
          <dt className="w-24 shrink-0 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
            Name
          </dt>
          <dd className="font-mono text-[12px] text-foreground">{name}</dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-24 shrink-0 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
            Description
          </dt>
          <dd className="min-w-0 flex-1 text-[12px] text-muted-foreground">{description}</dd>
        </div>
      </dl>
      {props.forksExisting && props.original ? (
        <p className="mt-2 border-t border-border pt-2 text-[12px] text-destructive">
          Saving this creates a new skill. The original,{" "}
          <span className="font-mono">
            {props.original.owner}/{props.original.name}
          </span>
          , stays as it is.
        </p>
      ) : null}
    </div>
  );
}
