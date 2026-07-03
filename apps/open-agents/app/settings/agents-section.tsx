"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, Plus, Save, Star, Trash2, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useAgentLibrary } from "@/hooks/use-agent-library";
import {
  AGENT_TOOL_NAMES,
  type AgentDefinition,
  type AgentEditorInput,
  type AgentLibraryItemScope,
  type AgentLibrarySaveScope,
  type AgentToolName,
  type SkillDocument,
  type SkillEditorInput,
} from "@/lib/agents/definitions";
import type { WorkspaceRepo } from "@/lib/workspace-repos";
import { cn } from "@/lib/utils";

const DEFAULT_AGENT_TOOLS: AgentToolName[] = [
  "todo",
  "read_file",
  "write_file",
  "grep",
  "glob",
  "bash",
  "web_fetch",
  "load_skill",
];

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "new-agent"
  );
}

function linesToArray(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function arrayToLines(value: string[]): string {
  return value.join("\n");
}

function formatRepo(repo: WorkspaceRepo): string {
  const branch = repo.branch ? `#${repo.branch}` : "";
  const directory = repo.directory && repo.directory !== repo.repo ? `:${repo.directory}` : "";
  return `${repo.owner}/${repo.repo}${branch}${directory}`;
}

function formatRepos(repos: WorkspaceRepo[]): string {
  return repos.map(formatRepo).join("\n");
}

function parseRepoLine(line: string): WorkspaceRepo {
  const [repoAndBranch, directoryRaw] = line.split(":", 2);
  const [coordinate, branchRaw] = (repoAndBranch ?? "").split("#", 2);
  const [owner, repo] = (coordinate ?? "").split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repo: ${line}`);
  }

  const branch = branchRaw?.trim() || "main";
  const directory = directoryRaw?.trim() || repo;
  return {
    owner,
    repo,
    branch,
    directory,
    cloneUrl: `https://github.com/${owner}/${repo}`,
  };
}

function parseRepos(value: string): WorkspaceRepo[] {
  return linesToArray(value).map(parseRepoLine);
}

function newAgentDraft(): AgentEditorInput {
  return {
    slug: "new-agent",
    name: "New Agent",
    description: "Describe when this agent should be used.",
    tools: DEFAULT_AGENT_TOOLS,
    repos: [],
    skills: [],
    model: undefined,
    systemPrompt: "# Instructions\n\nDescribe how this agent should behave.",
  };
}

function newSkillDraft(): SkillEditorInput {
  return {
    id: "new-skill",
    name: "new-skill",
    description: "Describe when this skill should be used.",
    body: "# Instructions\n\nDescribe the procedure this skill should load.",
    allowedTools: [],
  };
}

function agentToDraft(agent: AgentDefinition): AgentEditorInput {
  return {
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    tools: agent.tools.length > 0 ? agent.tools : DEFAULT_AGENT_TOOLS,
    repos: agent.repos,
    skills: agent.skills,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
  };
}

function skillToDraft(skill: SkillDocument): SkillEditorInput {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    userInvocable: skill.userInvocable,
    disableModelInvocation: skill.disableModelInvocation,
    allowedTools: skill.allowedTools ?? [],
    context: skill.context,
    agent: skill.agent,
  };
}

const MULTILINE_FIELD_CLASS =
  "w-full max-w-full overflow-x-hidden break-words whitespace-pre-wrap [field-sizing:fixed] [overflow-wrap:anywhere]";

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

function scopeLabel(scope: AgentLibraryItemScope): string {
  if (scope === "org") return "Org";
  if (scope === "user") return "Personal";
  return "Bundled";
}

function ScopeBadge({ scope }: { scope: AgentLibraryItemScope }) {
  return (
    <span className="rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {scopeLabel(scope)}
    </span>
  );
}

function SaveScopeSelect({
  value,
  onChange,
  disabled,
}: {
  value: AgentLibrarySaveScope;
  onChange: (scope: AgentLibrarySaveScope) => void;
  disabled: boolean;
}) {
  return (
    <div className="grid min-w-0 gap-2 sm:max-w-xs">
      <Label htmlFor="library-save-scope">Save scope</Label>
      <Select
        value={value}
        onValueChange={(next) => onChange(next as AgentLibrarySaveScope)}
        disabled={disabled}
      >
        <SelectTrigger id="library-save-scope">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="user">Personal</SelectItem>
          <SelectItem value="org">Org shared</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Personal is visible only to you. Org shared is visible to everyone on this deployment.
      </p>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{label}</p>
  );
}

function AgentList({
  agents,
  selectedSlug,
  defaultAgentName,
  onSelect,
  onNew,
}: {
  agents: AgentDefinition[];
  selectedSlug: string | null;
  defaultAgentName: string | null;
  onSelect: (agent: AgentDefinition) => void;
  onNew: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <SectionHeader>Agents</SectionHeader>
        <Button type="button" size="sm" variant="outline" onClick={onNew}>
          <Plus />
          New
        </Button>
      </div>
      {agents.length === 0 ? (
        <EmptyState label="No agents yet. Create one to reuse a configured tool, repo, skill, model, and prompt profile." />
      ) : (
        <div className="divide-y divide-border/60 rounded-lg border border-border/70">
          {agents.map((agent) => {
            const active = selectedSlug === agent.slug;
            return (
              <button
                key={agent.slug}
                type="button"
                onClick={() => onSelect(agent)}
                className={cn(
                  "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50",
                  active && "bg-muted/70",
                )}
              >
                <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-medium">
                    <span className="min-w-0 break-words">{agent.name}</span>
                    {defaultAgentName === agent.slug && (
                      <Star className="size-3 fill-current text-amber-500" />
                    )}
                    <ScopeBadge scope={agent.scope} />
                  </span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {agent.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SkillList({
  skills,
  selectedId,
  onSelect,
  onNew,
}: {
  skills: SkillDocument[];
  selectedId: string | null;
  onSelect: (skill: SkillDocument) => void;
  onNew: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <SectionHeader>Skills</SectionHeader>
        <Button type="button" size="sm" variant="outline" onClick={onNew}>
          <Plus />
          New
        </Button>
      </div>
      {skills.length === 0 ? (
        <EmptyState label="No portal skills yet. Skills can live in nested folders like devops/aws and agents can select them with devops/*." />
      ) : (
        <div className="divide-y divide-border/60 rounded-lg border border-border/70">
          {skills.map((skill) => {
            const active = selectedId === skill.id;
            return (
              <button
                key={skill.id}
                type="button"
                onClick={() => onSelect(skill)}
                className={cn(
                  "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50",
                  active && "bg-muted/70",
                )}
              >
                <WandSparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="break-all font-mono text-sm font-medium">{skill.id}</span>
                    <ScopeBadge scope={skill.scope} />
                  </span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {skill.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AgentEditor({
  draft,
  setDraft,
  saveScope,
  setSaveScope,
  defaultAgentName,
  isSaving,
  canDelete,
  canSetDefault,
  onSave,
  onDelete,
  onSetDefault,
}: {
  draft: AgentEditorInput;
  setDraft: (draft: AgentEditorInput) => void;
  saveScope: AgentLibrarySaveScope;
  setSaveScope: (scope: AgentLibrarySaveScope) => void;
  defaultAgentName: string | null;
  isSaving: boolean;
  canDelete: boolean;
  canSetDefault: boolean;
  onSave: (draft: AgentEditorInput, setDefault?: boolean) => void;
  onDelete: () => void;
  onSetDefault: () => void;
}) {
  const [reposText, setReposText] = useState(() => formatRepos(draft.repos));
  const [skillsText, setSkillsText] = useState(() => arrayToLines(draft.skills));

  useEffect(() => {
    setReposText(formatRepos(draft.repos));
    setSkillsText(arrayToLines(draft.skills));
  }, [draft.repos, draft.skills, draft.slug]);

  const syncStructuredFields = (): AgentEditorInput => {
    const next = {
      ...draft,
      repos: parseRepos(reposText),
      skills: linesToArray(skillsText),
    };
    setDraft(next);
    return next;
  };

  const handleSave = (setDefault?: boolean) => {
    try {
      const next = syncStructuredFields();
      onSave(next, setDefault);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invalid agent fields");
    }
  };

  return (
    <div className="min-w-0 space-y-6">
      <SaveScopeSelect value={saveScope} onChange={setSaveScope} disabled={isSaving} />

      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="grid min-w-0 gap-2">
          <Label htmlFor="agent-name">Name</Label>
          <Input
            id="agent-name"
            value={draft.name}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value, slug: slugify(event.target.value) })
            }
            disabled={isSaving}
          />
        </div>
        <div className="grid min-w-0 gap-2">
          <Label htmlFor="agent-slug">File slug</Label>
          <Input
            id="agent-slug"
            value={draft.slug}
            onChange={(event) => setDraft({ ...draft, slug: slugify(event.target.value) })}
            disabled={isSaving}
          />
        </div>
      </div>

      <div className="grid min-w-0 gap-2">
        <Label htmlFor="agent-description">Description</Label>
        <Textarea
          id="agent-description"
          value={draft.description}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          className={cn("min-h-20", MULTILINE_FIELD_CLASS)}
          disabled={isSaving}
        />
      </div>

      <div className="grid min-w-0 gap-2">
        <Label htmlFor="agent-model">Provider/model</Label>
        <Input
          id="agent-model"
          value={draft.model ?? ""}
          onChange={(event) =>
            setDraft({ ...draft, model: event.target.value.trim() || undefined })
          }
          placeholder="anthropic/claude-sonnet-4.6"
          disabled={isSaving}
        />
      </div>

      <div className="space-y-3">
        <SectionHeader>Tools</SectionHeader>
        <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {AGENT_TOOL_NAMES.map((toolName) => {
            const checked = draft.tools.includes(toolName);
            return (
              <label
                key={toolName}
                className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm"
              >
                <span className="min-w-0 break-all font-mono text-xs">{toolName}</span>
                <Switch
                  checked={checked}
                  onCheckedChange={(nextChecked) =>
                    setDraft({
                      ...draft,
                      tools: nextChecked
                        ? [...draft.tools, toolName]
                        : draft.tools.filter((item) => item !== toolName),
                    })
                  }
                  disabled={isSaving}
                />
              </label>
            );
          })}
        </div>
      </div>

      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <div className="grid min-w-0 gap-2">
          <Label htmlFor="agent-skills">Skill filters</Label>
          <Textarea
            id="agent-skills"
            value={skillsText}
            onChange={(event) => setSkillsText(event.target.value)}
            placeholder={"devops/*\nwrdn-typescript-type-safety"}
            className={cn("min-h-28 font-mono text-xs", MULTILINE_FIELD_CLASS)}
            disabled={isSaving}
          />
          <p className="text-xs text-muted-foreground">Supports nested prefixes like devops/*.</p>
        </div>
        <div className="grid min-w-0 gap-2">
          <Label htmlFor="agent-repos">Default repos</Label>
          <Textarea
            id="agent-repos"
            value={reposText}
            onChange={(event) => setReposText(event.target.value)}
            placeholder={"owner/repo#main:repo\nowner/another#staging"}
            className={cn("min-h-28 font-mono text-xs", MULTILINE_FIELD_CLASS)}
            disabled={isSaving}
          />
          <p className="text-xs text-muted-foreground">
            Used when creating a session with this agent and no repo is selected.
          </p>
        </div>
      </div>

      <div className="grid min-w-0 gap-2">
        <Label>System prompt</Label>
        <MarkdownEditor
          value={draft.systemPrompt}
          onChange={(systemPrompt) => setDraft({ ...draft, systemPrompt })}
          placeholder="Agent system prompt"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => handleSave(false)} disabled={isSaving}>
          <Save />
          Save agent
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => handleSave(true)}
          disabled={isSaving}
        >
          <Star />
          Save & set default
        </Button>
        {defaultAgentName === draft.slug ? (
          <Button type="button" variant="secondary" onClick={onSetDefault} disabled={isSaving}>
            Clear default
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            onClick={onSetDefault}
            disabled={isSaving || !canSetDefault}
          >
            Set default
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
          disabled={isSaving || !canDelete}
        >
          <Trash2 />
          Delete
        </Button>
      </div>
    </div>
  );
}

function SkillEditor({
  draft,
  setDraft,
  saveScope,
  setSaveScope,
  isSaving,
  canDelete,
  onSave,
  onDelete,
}: {
  draft: SkillEditorInput;
  setDraft: (draft: SkillEditorInput) => void;
  saveScope: AgentLibrarySaveScope;
  setSaveScope: (scope: AgentLibrarySaveScope) => void;
  isSaving: boolean;
  canDelete: boolean;
  onSave: (draft: SkillEditorInput) => void;
  onDelete: () => void;
}) {
  const [allowedToolsText, setAllowedToolsText] = useState(() => arrayToLines(draft.allowedTools));

  useEffect(() => {
    setAllowedToolsText(arrayToLines(draft.allowedTools));
  }, [draft.allowedTools, draft.id]);

  const handleSave = () => {
    const next = { ...draft, allowedTools: linesToArray(allowedToolsText) };
    setDraft(next);
    onSave(next);
  };

  return (
    <div className="min-w-0 space-y-6">
      <SaveScopeSelect value={saveScope} onChange={setSaveScope} disabled={isSaving} />

      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="grid min-w-0 gap-2">
          <Label htmlFor="skill-name">Name</Label>
          <Input
            id="skill-name"
            value={draft.name}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value, id: slugify(event.target.value) })
            }
            disabled={isSaving}
          />
        </div>
        <div className="grid min-w-0 gap-2">
          <Label htmlFor="skill-id">Folder path</Label>
          <Input
            id="skill-id"
            value={draft.id}
            onChange={(event) => setDraft({ ...draft, id: event.target.value })}
            placeholder="devops/aws"
            disabled={isSaving}
          />
        </div>
      </div>

      <div className="grid min-w-0 gap-2">
        <Label htmlFor="skill-description">Description</Label>
        <Textarea
          id="skill-description"
          value={draft.description}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          className={cn("min-h-20", MULTILINE_FIELD_CLASS)}
          disabled={isSaving}
        />
      </div>

      <div className="grid min-w-0 gap-4 sm:grid-cols-3">
        <label className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm">
          <span className="min-w-0 break-words">User invocable</span>
          <Switch
            checked={draft.userInvocable ?? true}
            onCheckedChange={(userInvocable) => setDraft({ ...draft, userInvocable })}
            disabled={isSaving}
          />
        </label>
        <label className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm">
          <span className="min-w-0 break-words">Disable model invocation</span>
          <Switch
            checked={draft.disableModelInvocation ?? false}
            onCheckedChange={(disableModelInvocation) =>
              setDraft({ ...draft, disableModelInvocation })
            }
            disabled={isSaving}
          />
        </label>
        <div className="grid min-w-0 gap-2">
          <Label htmlFor="skill-agent">Agent hint</Label>
          <Input
            id="skill-agent"
            value={draft.agent ?? ""}
            onChange={(event) => setDraft({ ...draft, agent: event.target.value || undefined })}
            placeholder="optional"
            disabled={isSaving}
          />
        </div>
      </div>

      <div className="grid min-w-0 gap-2">
        <Label htmlFor="skill-allowed-tools">Allowed tools</Label>
        <Textarea
          id="skill-allowed-tools"
          value={allowedToolsText}
          onChange={(event) => setAllowedToolsText(event.target.value)}
          placeholder={"read\ngrep\nwrite"}
          className={cn("min-h-24 font-mono text-xs", MULTILINE_FIELD_CLASS)}
          disabled={isSaving}
        />
      </div>

      <div className="grid min-w-0 gap-2">
        <Label>Skill markdown</Label>
        <MarkdownEditor
          value={draft.body}
          onChange={(body) => setDraft({ ...draft, body })}
          placeholder="Skill instructions"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={handleSave} disabled={isSaving}>
          <Save />
          Save skill
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
          disabled={isSaving || !canDelete}
        >
          <Trash2 />
          Delete
        </Button>
      </div>
    </div>
  );
}

export function AgentsSection() {
  const { library, loading, error, saveAgent, saveSkill, deleteItem, setDefaultAgent } =
    useAgentLibrary();
  const [tab, setTab] = useState("agents");
  const [agentDraft, setAgentDraft] = useState<AgentEditorInput>(() => newAgentDraft());
  const [skillDraft, setSkillDraft] = useState<SkillEditorInput>(() => newSkillDraft());
  const [agentSaveScope, setAgentSaveScope] = useState<AgentLibrarySaveScope>("user");
  const [skillSaveScope, setSkillSaveScope] = useState<AgentLibrarySaveScope>("user");
  const [isSaving, setIsSaving] = useState(false);

  const selectedAgentSlug = agentDraft.slug;
  const selectedSkillId = skillDraft.id;
  const agents = library?.agents ?? [];
  const skills = library?.skills ?? [];
  const defaultAgentName = library?.defaultAgentName ?? null;
  const selectedAgent = agents.find((agent) => agent.slug === selectedAgentSlug);
  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId);
  const agentDeleteScope =
    selectedAgent?.scope === "user" || selectedAgent?.scope === "org" ? selectedAgent.scope : null;
  const skillDeleteScope =
    selectedSkill?.scope === "user" || selectedSkill?.scope === "org" ? selectedSkill.scope : null;

  const subtitle = useMemo(() => {
    if (tab === "agents") {
      return "Agents are saved to your personal library or the org-shared library. Bundled markdown agents are still loaded from .agents/agents.";
    }
    return "Skills are saved to your personal library or the org-shared library. Bundled markdown skills are still loaded from .agents/skills.";
  }, [tab]);

  if (loading) {
    return <Skeleton className="h-[42rem] rounded-xl" />;
  }

  if (error) {
    return <p className="text-sm text-destructive">{error}</p>;
  }

  const handleSaveAgent = async (draft: AgentEditorInput, setDefault?: boolean) => {
    setIsSaving(true);
    try {
      const saved = await saveAgent(draft, { setDefault, scope: agentSaveScope });
      setAgentDraft(agentToDraft(saved));
      setAgentSaveScope(saved.scope === "org" ? "org" : "user");
      toast.success(agentSaveScope === "org" ? "Org agent saved" : "Agent saved");
    } catch (saveError) {
      toast.error(saveError instanceof Error ? saveError.message : "Failed to save agent");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveSkill = async (draft: SkillEditorInput) => {
    setIsSaving(true);
    try {
      const saved = await saveSkill(draft, { scope: skillSaveScope });
      setSkillDraft(skillToDraft(saved));
      setSkillSaveScope(saved.scope === "org" ? "org" : "user");
      toast.success(skillSaveScope === "org" ? "Org skill saved" : "Skill saved");
    } catch (saveError) {
      toast.error(saveError instanceof Error ? saveError.message : "Failed to save skill");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteAgent = async () => {
    if (!agentDeleteScope) {
      return;
    }

    setIsSaving(true);
    try {
      await deleteItem("agent", agentDraft.slug, agentDeleteScope);
      setAgentDraft(newAgentDraft());
      setAgentSaveScope("user");
      toast.success("Agent deleted");
    } catch (deleteError) {
      toast.error(deleteError instanceof Error ? deleteError.message : "Failed to delete agent");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteSkill = async () => {
    if (!skillDeleteScope) {
      return;
    }

    setIsSaving(true);
    try {
      await deleteItem("skill", skillDraft.id, skillDeleteScope);
      setSkillDraft(newSkillDraft());
      setSkillSaveScope("user");
      toast.success("Skill deleted");
    } catch (deleteError) {
      toast.error(deleteError instanceof Error ? deleteError.message : "Failed to delete skill");
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleDefault = async () => {
    setIsSaving(true);
    try {
      await setDefaultAgent(defaultAgentName === agentDraft.slug ? null : agentDraft.slug);
      toast.success(
        defaultAgentName === agentDraft.slug ? "Default agent cleared" : "Default agent set",
      );
    } catch (defaultError) {
      toast.error(
        defaultError instanceof Error ? defaultError.message : "Failed to update default agent",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Tabs value={tab} onValueChange={setTab} className="min-w-0 space-y-5 pr-1 sm:pr-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-3xl text-sm text-muted-foreground">{subtitle}</p>
        <TabsList>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="agents" className="grid min-w-0 gap-6 xl:grid-cols-[20rem_minmax(0,1fr)]">
        <AgentList
          agents={agents}
          selectedSlug={selectedAgentSlug}
          defaultAgentName={defaultAgentName}
          onSelect={(agent) => {
            setAgentDraft(agentToDraft(agent));
            setAgentSaveScope(agent.scope === "org" ? "org" : "user");
          }}
          onNew={() => {
            setAgentDraft(newAgentDraft());
            setAgentSaveScope("user");
          }}
        />
        <div className="min-w-0 overflow-hidden rounded-xl border border-border/70 p-4 sm:p-5">
          <AgentEditor
            draft={agentDraft}
            setDraft={setAgentDraft}
            saveScope={agentSaveScope}
            setSaveScope={setAgentSaveScope}
            defaultAgentName={defaultAgentName}
            isSaving={isSaving}
            canDelete={agentDeleteScope !== null}
            canSetDefault={selectedAgent !== undefined}
            onSave={(draft, setDefault) => void handleSaveAgent(draft, setDefault)}
            onDelete={() => void handleDeleteAgent()}
            onSetDefault={() => void handleToggleDefault()}
          />
        </div>
      </TabsContent>

      <TabsContent value="skills" className="grid min-w-0 gap-6 xl:grid-cols-[20rem_minmax(0,1fr)]">
        <SkillList
          skills={skills}
          selectedId={selectedSkillId}
          onSelect={(skill) => {
            setSkillDraft(skillToDraft(skill));
            setSkillSaveScope(skill.scope === "org" ? "org" : "user");
          }}
          onNew={() => {
            setSkillDraft(newSkillDraft());
            setSkillSaveScope("user");
          }}
        />
        <div className="min-w-0 overflow-hidden rounded-xl border border-border/70 p-4 sm:p-5">
          <SkillEditor
            draft={skillDraft}
            setDraft={setSkillDraft}
            saveScope={skillSaveScope}
            setSaveScope={setSkillSaveScope}
            isSaving={isSaving}
            canDelete={skillDeleteScope !== null}
            onSave={(draft) => void handleSaveSkill(draft)}
            onDelete={() => void handleDeleteSkill()}
          />
        </div>
      </TabsContent>
    </Tabs>
  );
}
