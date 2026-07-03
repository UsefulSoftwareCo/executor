type ValidRenameTitleInput = {
  draftTitle: string;
  originalTitle: string;
};

export function getValidRenameTitle({
  draftTitle,
  originalTitle,
}: ValidRenameTitleInput): string | null {
  const trimmed = draftTitle.trim();
  if (!trimmed || trimmed === originalTitle) {
    return null;
  }
  return trimmed;
}

type RenameSaveDisabledInput = {
  renaming: boolean;
  hasTargetSession: boolean;
  draftTitle: string;
  originalTitle: string | null;
};

export function isRenameSaveDisabled({
  renaming,
  hasTargetSession,
  draftTitle,
  originalTitle,
}: RenameSaveDisabledInput): boolean {
  if (renaming || !hasTargetSession || !originalTitle) {
    return true;
  }

  return getValidRenameTitle({ draftTitle, originalTitle }) === null;
}
