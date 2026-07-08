import { useEffect, useMemo, useState } from "react";
import { Effect, Exit } from "effect";

import { Button } from "@executor-js/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor-js/react/components/card-stack";
import { FloatActions } from "@executor-js/react/components/float-actions";
import { Input } from "@executor-js/react/components/input";
import { Checkbox } from "@executor-js/react/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@executor-js/react/components/dialog";
import { FormErrorAlert, useSlugAlreadyExists } from "@executor-js/react/lib/integration-add";

import {
  createCustomToolSourceEffect,
  formatSyncErrors,
  listCustomToolDirectoriesEffect,
  parseGitSourceUrl,
  slugifyCustomToolsAppName,
  suggestCustomToolsAppName,
  syncCustomToolSourceEffect,
  validateCustomToolsAppSlug,
  validateGitSourceUrl,
  type CustomToolsDirectoryListing,
  type AppSourceKind,
} from "./custom-tools-client";
import { directoryBrowserRows } from "./source-panel-model";

export default function AddCustomToolsSource(props: {
  readonly onComplete: (slug?: string) => void;
  readonly onCancel: () => void;
  readonly initialUrl?: string;
  readonly initialNamespace?: string;
  readonly sourceKinds?: readonly AppSourceKind[];
}) {
  const sourceKinds = props.sourceKinds ?? ["git"];
  const allowLocalDirectory = sourceKinds.includes("local-directory");
  const initialKind =
    props.initialUrl && props.initialUrl.startsWith("/") && allowLocalDirectory
      ? "local-directory"
      : "git";
  const [kind, setKind] = useState<AppSourceKind>(initialKind);
  const [url, setUrl] = useState(props.initialUrl ?? "");
  const [path, setPath] = useState(
    initialKind === "local-directory" ? (props.initialUrl ?? "") : "",
  );
  const [ref, setRef] = useState("");
  const [name, setName] = useState(
    props.initialNamespace ? slugifyCustomToolsAppName(props.initialNamespace) : "",
  );
  const [nameTouched, setNameTouched] = useState(props.initialNamespace !== undefined);
  const [token, setToken] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);

  const sourceValue = kind === "git" ? url : path;
  const effectiveName = useMemo(
    () => (nameTouched ? name : slugifyCustomToolsAppName(suggestCustomToolsAppName(sourceValue))),
    [name, nameTouched, sourceValue],
  );
  const slug = effectiveName;
  const slugAlreadyExists = useSlugAlreadyExists(slug);

  const submit = async () => {
    const nextFieldError =
      kind === "git"
        ? validateGitSourceUrl(url)
        : path.trim().startsWith("/")
          ? null
          : "Enter an absolute directory path.";
    const nextNameError = validateCustomToolsAppSlug(slug);
    setFieldError(nextFieldError);
    setNameError(nextNameError);
    setSyncError(null);
    if (nextFieldError || nextNameError) return;
    if (slugAlreadyExists) {
      setSyncError(`An integration named "${slug}" already exists. Choose another source name.`);
      return;
    }

    setSyncing(true);
    const parsedGitUrl = kind === "git" ? parseGitSourceUrl(url) : null;
    const createExit = await Effect.runPromiseExit(
      createCustomToolSourceEffect(
        kind === "git"
          ? {
              kind: "git",
              slug,
              app: slug,
              url: parsedGitUrl?.ok ? parsedGitUrl.url : url.trim(),
              ...(ref.trim() ? { ref: ref.trim() } : {}),
              ...(token.trim() ? { token: token.trim() } : {}),
            }
          : { kind: "local-directory", slug, app: slug, path: path.trim() },
      ),
    );
    if (Exit.isFailure(createExit)) {
      setSyncError("Failed to create custom tools source.");
      setSyncing(false);
      return;
    }
    const syncExit = await Effect.runPromiseExit(
      syncCustomToolSourceEffect(createExit.value.source.slug),
    );
    if (Exit.isFailure(syncExit)) {
      setSyncError("Failed to sync custom tools source.");
      setSyncing(false);
      return;
    }
    const result = syncExit.value;
    if (result.status === "failed") {
      setSyncError(formatSyncErrors(result).join("\n") || "Sync failed.");
      setSyncing(false);
      return;
    }
    setSyncing(false);
    props.onComplete(createExit.value.source.app);
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Add custom tools</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Sync tools from a Git repository, then publish them to the Apps catalog.
        </p>
      </div>

      <CardStack>
        <CardStackContent className="border-t-0">
          {allowLocalDirectory && (
            <CardStackEntryField
              label="Source type"
              description="- Git is portable. Local directories are local-only."
            >
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={kind === "git" ? "default" : "outline"}
                  onClick={() => setKind("git")}
                  disabled={syncing}
                >
                  Git repository
                </Button>
                <Button
                  type="button"
                  variant={kind === "local-directory" ? "default" : "outline"}
                  onClick={() => setKind("local-directory")}
                  disabled={syncing}
                >
                  Directory path
                </Button>
              </div>
            </CardStackEntryField>
          )}

          {kind === "git" ? (
            <>
              <CardStackEntryField label="Git repository" description="- Any https Git remote.">
                <div className="space-y-1.5">
                  <Input
                    value={url}
                    onChange={(event) => {
                      setUrl((event.target as HTMLInputElement).value);
                      setFieldError(null);
                      setSyncError(null);
                    }}
                    onBlur={() => setFieldError(validateGitSourceUrl(url))}
                    placeholder="https://github.com/acme/tools.git"
                    className="font-mono text-sm"
                    aria-invalid={fieldError ? true : undefined}
                  />
                  {fieldError && <p className="text-xs text-destructive">{fieldError}</p>}
                </div>
              </CardStackEntryField>
              <CardStackEntryField
                label="Ref (optional)"
                description="- Branch, tag, or commit SHA."
              >
                <Input
                  value={ref}
                  onChange={(event) => setRef((event.target as HTMLInputElement).value)}
                  placeholder="main"
                  className="font-mono text-sm"
                  disabled={syncing}
                />
              </CardStackEntryField>
              <CardStackEntryField
                label="Token (optional)"
                description="- For private repositories. Never shown after saving."
              >
                <Input
                  value={token}
                  type="password"
                  onChange={(event) => setToken((event.target as HTMLInputElement).value)}
                  autoComplete="off"
                  className="font-mono text-sm"
                  disabled={syncing}
                />
              </CardStackEntryField>
            </>
          ) : (
            <CardStackEntryField
              label="Directory path"
              description="- Absolute path on this machine."
            >
              <div className="space-y-1.5">
                <div className="flex gap-2">
                  <Input
                    value={path}
                    onChange={(event) => {
                      setPath((event.target as HTMLInputElement).value);
                      setFieldError(null);
                      setSyncError(null);
                    }}
                    placeholder="/Users/me/tools"
                    className="font-mono text-sm"
                    aria-invalid={fieldError ? true : undefined}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setBrowseOpen(true)}
                    disabled={syncing}
                  >
                    Browse
                  </Button>
                </div>
                {fieldError && <p className="text-xs text-destructive">{fieldError}</p>}
              </div>
            </CardStackEntryField>
          )}

          <CardStackEntryField
            label="Source name"
            description="- Lowercase letters, numbers, and hyphens."
          >
            <div className="space-y-1.5">
              <Input
                value={effectiveName}
                onChange={(event) => {
                  setNameTouched(true);
                  setName(slugifyCustomToolsAppName((event.target as HTMLInputElement).value));
                  setNameError(null);
                  setSyncError(null);
                }}
                placeholder="custom-tools"
                className="text-sm"
                aria-invalid={nameError ? true : undefined}
              />
              {nameError && <p className="text-xs text-destructive">{nameError}</p>}
              {slugAlreadyExists && !syncing && !nameError && (
                <p className="text-xs text-destructive">
                  An integration named &quot;{slug}&quot; already exists.
                </p>
              )}
            </div>
          </CardStackEntryField>
        </CardStackContent>
      </CardStack>

      {syncError && <FormErrorAlert message={syncError} />}

      <FloatActions>
        <Button type="button" variant="ghost" onClick={() => props.onCancel()} disabled={syncing}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void submit()} disabled={syncing} loading={syncing}>
          Sync source
        </Button>
      </FloatActions>
      {browseOpen && (
        <DirectoryBrowserModal
          initialPath={path.trim() || undefined}
          onClose={() => setBrowseOpen(false)}
          onSelect={(selectedPath) => {
            setPath(selectedPath);
            setFieldError(null);
            setSyncError(null);
            setBrowseOpen(false);
          }}
        />
      )}
    </div>
  );
}

function DirectoryBrowserModal(props: {
  readonly initialPath?: string;
  readonly onSelect: (path: string) => void;
  readonly onClose: () => void;
}) {
  const [currentPath, setCurrentPath] = useState(props.initialPath);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [listing, setListing] = useState<CustomToolsDirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void Effect.runPromiseExit(
      listCustomToolDirectoriesEffect({ path: currentPath, includeHidden }),
    ).then((exit) => {
      if (!active) return;
      setLoading(false);
      if (Exit.isFailure(exit)) {
        setError("Unable to read this directory.");
        return;
      }
      setListing(exit.value);
      setCurrentPath(exit.value.path);
    });
    return () => {
      active = false;
    };
  }, [currentPath, includeHidden]);

  const rows = listing ? directoryBrowserRows(listing) : [];
  const selectedPath = listing?.path ?? currentPath ?? "";

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogContent className="sm:max-w-[620px]">
        <DialogHeader className="border-b border-border/60 pb-4">
          <DialogTitle className="text-base">Choose directory</DialogTitle>
          <DialogDescription className="font-mono text-xs break-all">
            {selectedPath || "Home"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={includeHidden}
              onCheckedChange={(checked) => setIncludeHidden(checked === true)}
            />
            Show hidden directories
          </label>
          <div className="max-h-[340px] overflow-auto rounded-md border border-border">
            {loading ? (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">Loading...</div>
            ) : error ? (
              <div className="px-3 py-8 text-center text-sm text-destructive">{error}</div>
            ) : rows.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                No subdirectories
              </div>
            ) : (
              <div role="listbox" aria-label="Directories" className="divide-y divide-border">
                {rows.map((row) => (
                  <button
                    key={`${row.kind}:${row.path}`}
                    type="button"
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    onClick={() => setCurrentPath(row.path)}
                  >
                    <span className="min-w-0 truncate font-mono">
                      {row.kind === "parent" ? ".." : row.name}
                    </span>
                    {row.kind === "dir" && row.isSymlink && (
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        symlink
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <DialogFooter className="border-t border-border/60 pt-4">
          <Button type="button" variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => props.onSelect(selectedPath)}
            disabled={!selectedPath || loading || Boolean(error)}
          >
            Select
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
