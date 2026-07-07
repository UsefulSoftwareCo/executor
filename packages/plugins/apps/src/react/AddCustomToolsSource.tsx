import { useState } from "react";
import { Effect, Exit } from "effect";

import { Button } from "@executor-js/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor-js/react/components/card-stack";
import { FloatActions } from "@executor-js/react/components/float-actions";
import { Input } from "@executor-js/react/components/input";
import { toast } from "@executor-js/react/components/sonner";
import { FormErrorAlert, useSlugAlreadyExists } from "@executor-js/react/lib/integration-add";

import {
  formatSyncErrors,
  slugifyCustomToolsAppName,
  suggestCustomToolsAppName,
  syncCustomToolSourceEffect,
  syncStatusLabel,
  validateCustomToolsAppSlug,
  validateGitHubSourceUrl,
} from "./custom-tools-client";

export default function AddCustomToolsSource(props: {
  readonly onComplete: (slug?: string) => void;
  readonly onCancel: () => void;
  readonly initialUrl?: string;
  readonly initialNamespace?: string;
}) {
  const [url, setUrl] = useState(props.initialUrl ?? "");
  const [name, setName] = useState(
    props.initialNamespace ? slugifyCustomToolsAppName(props.initialNamespace) : "",
  );
  const [nameTouched, setNameTouched] = useState(props.initialNamespace !== undefined);
  const [token, setToken] = useState("");
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const effectiveName = nameTouched
    ? name
    : slugifyCustomToolsAppName(suggestCustomToolsAppName(url));
  const slug = effectiveName;
  const slugAlreadyExists = useSlugAlreadyExists(slug);

  const submit = async () => {
    const validation = validateGitHubSourceUrl(url);
    const nextNameError = validateCustomToolsAppSlug(slug);
    setUrlError(validation);
    setNameError(nextNameError);
    setSyncError(null);
    if (validation || nextNameError) return;
    if (slugAlreadyExists) {
      setSyncError(`An integration named "${slug}" already exists. Choose another name.`);
      return;
    }

    setSyncing(true);
    const exit = await Effect.runPromiseExit(
      syncCustomToolSourceEffect({
        name: slug,
        url,
        token,
      }),
    );
    if (Exit.isFailure(exit)) {
      setSyncError("Failed to sync custom tools.");
      setSyncing(false);
      return;
    }
    const result = exit.value;
    if (result.status === "failed") {
      setSyncError(formatSyncErrors(result).join("\n") || "Sync failed.");
      setSyncing(false);
      return;
    }
    toast.success(syncStatusLabel(result));
    props.onComplete(slug);
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Add custom tools</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Sync a GitHub repository that defines tools with executor:app.
        </p>
      </div>

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField
            label="GitHub URL"
            description="- Repository URL, optionally with /tree/<ref> or /commit/<sha>."
          >
            <div className="space-y-1.5">
              <Input
                value={url}
                onChange={(event) => {
                  setUrl((event.target as HTMLInputElement).value);
                  setUrlError(null);
                  setNameError(null);
                  setSyncError(null);
                }}
                onBlur={() => setUrlError(validateGitHubSourceUrl(url))}
                placeholder="https://github.com/UsefulSoftwareCo/executor"
                className="font-mono text-sm"
                aria-invalid={urlError ? true : undefined}
              />
              {urlError && <p className="text-xs text-destructive">{urlError}</p>}
            </div>
          </CardStackEntryField>

          <CardStackEntryField
            label="Name"
            description="- Lowercase letters, numbers, and hyphens. Addresses use this name."
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
                placeholder="executor-custom-tools-demo"
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

          <CardStackEntryField
            label="Access token (optional)"
            description="- Needed only for private repositories or higher GitHub API limits."
          >
            <div className="flex gap-2">
              <Input
                value={token}
                type={tokenRevealed ? "text" : "password"}
                onChange={(event) => {
                  setToken((event.target as HTMLInputElement).value);
                  setSyncError(null);
                }}
                autoComplete="off"
                className="font-mono text-sm"
              />
              <Button
                type="button"
                variant="outline"
                aria-pressed={tokenRevealed}
                onClick={() => setTokenRevealed((revealed) => !revealed)}
                disabled={syncing}
              >
                Show
              </Button>
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
          Sync repo
        </Button>
      </FloatActions>
    </div>
  );
}
