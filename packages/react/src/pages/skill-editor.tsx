import { useEffect, useRef, useState } from "react";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import type {
  ManagedSkillId,
  Owner,
  SkillCandidateId,
  SkillRevisionId,
} from "@executor-js/sdk/shared";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import {
  createSkill,
  discoverSkills,
  editSkill,
  exportSkill,
  importSkillCandidate,
  skillAtom,
  skillsOptimisticAtom,
} from "../api/atoms";
import { useOrganizationId } from "../api/organization-context";
import { skillWriteKeys } from "../api/reactivity-keys";
import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { FieldLabel } from "../components/field";
import { Input } from "../components/input";
import { Label } from "../components/label";
import { PageContainer, PageHeader } from "../components/page";
import { Textarea } from "../components/textarea";
import { useExecutorDocumentTitle } from "../lib/document-title";
import { FormErrorAlert } from "../lib/integration-add";
import { useCanCreateWorkspaceConnections } from "../multiplayer/use-admin-nav";
import {
  connectionOwnerOptionsForAccess,
  ConnectionOwnerDropdown,
  defaultConnectionOwnerForHost,
  normalizeConnectionOwner,
} from "../plugins/connection-owner";

const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when an agent should load it.
---

# My skill

Write the instructions an agent should follow here.
`;

interface FileDraft {
  readonly id: number;
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: string;
  readonly text: string | null;
}

interface CandidatePreview {
  readonly id: SkillCandidateId;
  readonly name: string | null;
  readonly description: string | null;
  readonly upstreamRevision: string;
}

function CandidateInstallActions(props: {
  readonly candidateIds: readonly SkillCandidateId[];
  readonly selectedCandidateIds: readonly SkillCandidateId[];
  readonly installing: boolean;
  readonly onInstall: (candidateIds: readonly SkillCandidateId[]) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-muted-foreground">
        {props.selectedCandidateIds.length} of {props.candidateIds.length} selected
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.selectedCandidateIds.length === 0}
          loading={props.installing}
          onClick={() => props.onInstall(props.selectedCandidateIds)}
        >
          Install selected
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={props.candidateIds.length === 0}
          loading={props.installing}
          onClick={() => props.onInstall(props.candidateIds)}
        >
          Install all
        </Button>
      </div>
    </div>
  );
}

const encodeBytes = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
};

const encodeText = (value: string): string => encodeBytes(new TextEncoder().encode(value));

const decodeText = (encoded: string): string => {
  const binary = globalThis.atob(encoded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
};

const isTextMediaType = (mediaType: string): boolean =>
  mediaType.startsWith("text/") ||
  mediaType.includes("json") ||
  mediaType.includes("yaml") ||
  mediaType.includes("xml") ||
  mediaType.includes("javascript");

const mediaTypeFor = (file: File): string =>
  file.type ||
  (file.name.endsWith(".md")
    ? "text/markdown; charset=utf-8"
    : file.name.endsWith(".json")
      ? "application/json"
      : "application/octet-stream");

export function SkillEditorPage(props: { readonly skillId?: ManagedSkillId | undefined }) {
  return props.skillId === undefined ? (
    <SkillEditorForm />
  ) : (
    <SkillEditorLoader skillId={props.skillId} />
  );
}

function SkillEditorLoader(props: { readonly skillId: ManagedSkillId }) {
  const skill = useAtomValue(skillAtom(props.skillId));
  const loadPackage = useAtomSet(exportSkill, { mode: "promiseExit" });
  const [files, setFiles] = useState<readonly FileDraft[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void loadPackage({
      params: { skillId: props.skillId },
      query: { kind: "backup" },
    }).then((exit) => {
      if (!active) return;
      if (Exit.isFailure(exit)) {
        setLoadFailed(true);
        return;
      }
      setFiles(
        exit.value.files.map((file, index) => ({
          id: index,
          path: file.path,
          mediaType: file.mediaType,
          bytes: file.bytes,
          text: isTextMediaType(file.mediaType) ? decodeText(file.bytes) : null,
        })),
      );
    });
    return () => {
      active = false;
    };
  }, [loadPackage, props.skillId]);

  if (!AsyncResult.isSuccess(skill) || files === null) {
    return (
      <PageContainer>
        <p className="text-sm text-muted-foreground">
          {loadFailed || AsyncResult.isFailure(skill)
            ? "This skill could not be opened for editing."
            : "Loading skill package..."}
        </p>
      </PageContainer>
    );
  }

  return (
    <SkillEditorForm
      skillId={props.skillId}
      owner={skill.value.owner}
      expectedActiveRevisionId={skill.value.activeRevisionId}
      initialFiles={files}
      title={skill.value.name ?? "blocked skill"}
    />
  );
}

function SkillEditorForm(props: {
  readonly skillId?: ManagedSkillId | undefined;
  readonly owner?: Owner | undefined;
  readonly expectedActiveRevisionId?: SkillRevisionId | undefined;
  readonly initialFiles?: readonly FileDraft[] | undefined;
  readonly title?: string | undefined;
}) {
  const editing = props.skillId !== undefined;
  useExecutorDocumentTitle(editing ? `Edit ${props.title ?? "skill"}` : "New skill");
  const organizationId = useOrganizationId();
  const canCreateWorkspaceConnections = useCanCreateWorkspaceConnections();
  const ownerOptions = connectionOwnerOptionsForAccess(
    organizationId,
    canCreateWorkspaceConnections,
  );
  const [owner, setOwner] = useState<Owner>(
    props.owner ?? defaultConnectionOwnerForHost(organizationId),
  );
  const [files, setFiles] = useState<readonly FileDraft[]>(
    props.initialFiles ?? [
      {
        id: 0,
        path: "SKILL.md",
        mediaType: "text/markdown; charset=utf-8",
        bytes: encodeText(NEW_SKILL_TEMPLATE),
        text: NEW_SKILL_TEMPLATE,
      },
    ],
  );
  const [saving, setSaving] = useState(false);
  const [sourceInput, setSourceInput] = useState("");
  const [followSource, setFollowSource] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [candidates, setCandidates] = useState<readonly CandidatePreview[]>([]);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<readonly SkillCandidateId[]>([]);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(files.length);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const create = useAtomSet(createSkill, { mode: "promiseExit" });
  const discover = useAtomSet(discoverSkills, { mode: "promiseExit" });
  const importCandidate = useAtomSet(importSkillCandidate, {
    mode: "promiseExit",
  });
  const edit = useAtomSet(editSkill, { mode: "promiseExit" });
  const refreshSkills = useAtomRefresh(skillsOptimisticAtom);
  const navigate = useNavigate();
  const activeOwner = normalizeConnectionOwner(owner, ownerOptions);

  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);

  const updateFile = (id: number, patch: Partial<Omit<FileDraft, "id">>) => {
    setFiles((current) => current.map((file) => (file.id === id ? { ...file, ...patch } : file)));
  };

  const removeFile = (id: number) => {
    setFiles((current) => current.filter((file) => file.id !== id));
  };

  const importFolder = async (picked: FileList) => {
    const selected = Array.from(picked);
    const relativePaths = selected.map((file) => file.webkitRelativePath || file.name);
    const roots = new Set(relativePaths.map((path) => path.split("/")[0]));
    const stripRoot = roots.size === 1 && relativePaths.every((path) => path.includes("/"));
    const imported = await Promise.all(
      selected.map(async (file, index): Promise<FileDraft> => {
        const rawPath = relativePaths[index] ?? file.name;
        const path = stripRoot ? rawPath.split("/").slice(1).join("/") : rawPath;
        const bytes = new Uint8Array(await file.arrayBuffer());
        const mediaType = mediaTypeFor(file);
        return {
          id: nextId.current++,
          path,
          mediaType,
          bytes: encodeBytes(bytes),
          text: isTextMediaType(mediaType) ? new TextDecoder().decode(bytes) : null,
        };
      }),
    );
    setFiles(imported);
  };

  const addTextFile = () => {
    setFiles((current) => [
      ...current,
      {
        id: nextId.current++,
        path: "",
        mediaType: "text/plain; charset=utf-8",
        bytes: "",
        text: "",
      },
    ]);
  };

  const discoverSource = async () => {
    if (discovering || sourceInput.trim() === "") return;
    setDiscovering(true);
    setError(null);
    const exit = await discover({
      payload: {
        source: sourceInput.trim(),
        owner: activeOwner,
        tracking: followSource ? "follow" : "pin",
      },
      reactivityKeys: skillWriteKeys,
    });
    setDiscovering(false);
    if (Exit.isFailure(exit)) {
      setError("Executor could not read that skill source.");
      return;
    }
    setCandidates(
      exit.value.candidates.map((candidate) => ({
        id: candidate.id,
        name: candidate.revision.name,
        description: candidate.revision.description,
        upstreamRevision: candidate.upstreamRevision,
      })),
    );
    setSelectedCandidateIds([]);
    if (exit.value.candidates.length === 0) {
      setError(exit.value.rejected[0]?.reason ?? "No importable skills were found.");
    }
  };

  const installCandidates = async (candidateIds: readonly SkillCandidateId[]) => {
    if (saving || candidateIds.length === 0) return;
    setSaving(true);
    setError(null);
    const installedIds: SkillCandidateId[] = [];
    let failed = false;
    for (const candidateId of candidateIds) {
      const exit = await importCandidate({
        payload: { candidateId },
        reactivityKeys: skillWriteKeys,
      });
      if (Exit.isFailure(exit)) {
        failed = true;
      } else {
        installedIds.push(candidateId);
      }
    }
    setSaving(false);
    if (installedIds.length > 0) {
      const installed = new Set(installedIds);
      setCandidates((current) => current.filter((candidate) => !installed.has(candidate.id)));
      setSelectedCandidateIds((current) => current.filter((id) => !installed.has(id)));
      refreshSkills();
    }
    if (failed) {
      setError(
        installedIds.length === 0
          ? "The selected skill previews expired or could not be installed."
          : `${installedIds.length} skills were installed, but some previews expired or could not be installed.`,
      );
      return;
    }
    await navigate({
      to: "/{-$orgSlug}/skills",
    });
  };

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    const packagePayload = {
      files: files.map((file) => ({
        path: file.path.trim(),
        mediaType: file.mediaType,
        bytes: file.text === null ? file.bytes : encodeText(file.text),
      })),
    };
    const exit =
      props.skillId === undefined || props.expectedActiveRevisionId === undefined
        ? await create({
            payload: { owner: activeOwner, package: packagePayload },
            reactivityKeys: skillWriteKeys,
          })
        : await edit({
            params: { skillId: props.skillId },
            payload: {
              owner: activeOwner,
              expectedActiveRevisionId: props.expectedActiveRevisionId,
              package: packagePayload,
            },
            reactivityKeys: skillWriteKeys,
          });
    setSaving(false);
    if (Exit.isFailure(exit)) {
      const nameConflict = Option.match(Exit.findErrorOption(exit), {
        onNone: () => false,
        onSome: Predicate.isTagged("SkillNameConflictError"),
      });
      setError(
        nameConflict
          ? `A ${activeOwner === "org" ? "workspace" : "personal"} skill with this name already exists.`
          : editing
            ? "The package could not be saved. It may have changed in another session."
            : "The package could not be created. Check its paths and size limits.",
      );
      return;
    }
    refreshSkills();
    await navigate({
      to: "/{-$orgSlug}/skills/$skillId",
      params: { skillId: exit.value.id },
    });
  };

  return (
    <PageContainer>
      <Button asChild variant="ghost" size="sm" className="-ml-3 mb-4 text-muted-foreground">
        <Link
          to={editing ? "/{-$orgSlug}/skills/$skillId" : "/{-$orgSlug}/skills"}
          params={editing && props.skillId ? { skillId: props.skillId } : {}}
        >
          {editing ? "Skill" : "Skills"}
        </Link>
      </Button>
      <PageHeader
        title={editing ? "Edit skill" : "New skill"}
        description="Executor stores the complete package and keeps every saved revision."
        actions={
          <Button type="button" size="sm" loading={saving} onClick={() => void submit()}>
            Save skill
          </Button>
        }
      />
      <div className="space-y-8">
        {error ? <FormErrorAlert message={error} /> : null}
        <ConnectionOwnerDropdown
          value={activeOwner}
          options={ownerOptions}
          onChange={setOwner}
          label="Owned by"
          help={
            editing
              ? "Changing the owner moves this skill and keeps its revision history."
              : "Personal skills are available to you. Workspace skills are shared."
          }
          className="max-w-xs space-y-1.5"
        />
        {!editing ? (
          <>
            <section className="space-y-3 rounded-lg border border-border bg-card p-4">
              <div>
                <FieldLabel>Import from GitHub</FieldLabel>
                <p className="mt-1 text-xs text-muted-foreground">
                  Paste a repository, GitHub URL, skills.sh URL, or skills install command.
                </p>
              </div>
              <div className="flex gap-2">
                <Input
                  value={sourceInput}
                  placeholder="owner/repository"
                  onChange={(event) => setSourceInput(event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  loading={discovering}
                  onClick={() => void discoverSource()}
                >
                  Preview
                </Button>
              </div>
              <Label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={followSource}
                  onCheckedChange={(checked) => setFollowSource(checked === true)}
                />
                Follow the selected ref for manual update checks
              </Label>
              {candidates.length > 0 ? (
                <div className="space-y-3">
                  <CandidateInstallActions
                    candidateIds={candidates.map((candidate) => candidate.id)}
                    selectedCandidateIds={selectedCandidateIds}
                    installing={saving}
                    onInstall={(candidateIds) => void installCandidates(candidateIds)}
                  />
                  <ul className="divide-y divide-border rounded-md border border-border">
                    {candidates.map((candidate) => {
                      const checked = selectedCandidateIds.includes(candidate.id);
                      const label = candidate.name ?? "Blocked package";
                      return (
                        <li key={candidate.id}>
                          <Label className="flex cursor-pointer items-start gap-3 px-3 py-3">
                            <Checkbox
                              checked={checked}
                              aria-label={`Select ${label}`}
                              onCheckedChange={(nextChecked) =>
                                setSelectedCandidateIds((current) =>
                                  nextChecked === true
                                    ? [...current, candidate.id]
                                    : current.filter((id) => id !== candidate.id),
                                )
                              }
                            />
                            <span className="min-w-0">
                              <span className="block text-sm font-medium">{label}</span>
                              <span className="block text-xs text-muted-foreground">
                                {candidate.description ?? "No valid description"} ·{" "}
                                {candidate.upstreamRevision.slice(0, 12)}
                              </span>
                            </span>
                          </Label>
                        </li>
                      );
                    })}
                  </ul>
                  <CandidateInstallActions
                    candidateIds={candidates.map((candidate) => candidate.id)}
                    selectedCandidateIds={selectedCandidateIds}
                    installing={saving}
                    onInstall={(candidateIds) => void installCandidates(candidateIds)}
                  />
                </div>
              ) : null}
            </section>
          </>
        ) : null}
        <section className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <FieldLabel>Package files</FieldLabel>
              <p className="mt-1 text-xs text-muted-foreground">
                A root SKILL.md is required. Scripts and binary assets remain inert.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={addTextFile}>
                Add text file
              </Button>
              <Button variant="outline" size="sm" onClick={() => folderInput.current?.click()}>
                Import folder
              </Button>
              <Input
                ref={folderInput}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  if (event.target.files) void importFolder(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>
          </div>
          <ul className="space-y-3">
            {files.map((file) => (
              <li key={file.id} className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-center gap-2">
                  <Input
                    value={file.path}
                    spellCheck={false}
                    onChange={(event) => updateFile(file.id, { path: event.target.value })}
                    className="font-mono text-xs"
                    aria-label="File path"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    disabled={file.path === "SKILL.md" && files.length === 1}
                    onClick={() => removeFile(file.id)}
                  >
                    Remove
                  </Button>
                </div>
                {file.text === null ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Binary file, {Math.floor((file.bytes.length * 3) / 4).toLocaleString()} bytes.
                  </p>
                ) : (
                  <Textarea
                    value={file.text}
                    spellCheck={false}
                    onChange={(event) =>
                      updateFile(file.id, {
                        text: event.target.value,
                        bytes: encodeText(event.target.value),
                      })
                    }
                    className="mt-2 min-h-40 font-mono text-xs leading-relaxed"
                    aria-label={`Contents of ${file.path || "file"}`}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </PageContainer>
  );
}
