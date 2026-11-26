import { Textarea } from "../components/textarea.tsx";

export interface AccountMetadataUpdate {
  readonly label?: string;
  readonly description?: string | null;
}

export const accountDescriptionMaxLength = 500;

export const accountDescriptionValue = (draft: string) => {
  const trimmed = draft.trim();
  return trimmed === "" ? null : trimmed;
};

export function AccountDescriptionField({
  value,
  onChange,
  disabled,
  disabledReason,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly disabledReason?: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-2 text-[13px] font-medium">
        Description for agents
        <Textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="e.g. Production workspace. Reads only; use the sandbox account for writes."
          maxLength={accountDescriptionMaxLength}
          rows={3}
          className="min-h-20"
          disabled={disabled}
          disabledReason={disabledReason}
        />
      </label>
      <span className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5]">
        Optional. Agents read it with the name to choose between accounts.
      </span>
    </div>
  );
}
