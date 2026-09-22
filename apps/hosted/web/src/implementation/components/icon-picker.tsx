import { DisabledTooltip } from "@executor-js/ui/components/disabled-tooltip";
import { useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Upload01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { Avatar, AvatarFallback, AvatarImage } from "@executor-js/ui/components/avatar";

/** Shared file-picker view; its caller owns validation, draft state, and persistence. */
export function IconPicker({
  name,
  preview,
  label,
  disabled,
  disabledReason,
  onSelect,
  onRemove,
}: {
  readonly name: string;
  readonly preview: string | null;
  readonly label: string;
  readonly disabled: boolean;
  readonly disabledReason?: string | undefined;
  readonly onSelect: (file: File) => void | Promise<void>;
  readonly onRemove: () => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <div className="group/icon-control relative w-fit shrink-0">
      <DisabledTooltip reason={disabledReason}>
        <button
          type="button"
          className="group/icon relative block size-11 cursor-pointer rounded-[10px] focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-4 disabled:cursor-wait"
          aria-label={label}
          title={label}
          disabled={disabled || disabledReason !== undefined}
          onClick={() => picker.current?.click()}
        >
          <Avatar className="size-11 rounded-[10px] transition-opacity duration-120 group-hover/icon:opacity-0 group-focus-visible/icon:opacity-0">
            <AvatarImage src={preview ?? undefined} alt="" />
            <AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span
            className="absolute inset-0 grid place-items-center rounded-[inherit] border border-dashed border-border bg-accent opacity-0 transition-opacity duration-120 group-hover/icon:opacity-100 group-focus-visible/icon:opacity-100"
            aria-hidden
          >
            <HugeiconsIcon icon={Upload01Icon} size={20} strokeWidth={2} />
          </span>
        </button>
      </DisabledTooltip>
      <input
        ref={picker}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose image file"
        accept="image/png,image/jpeg,image/webp"
        disabled={disabled || disabledReason !== undefined}
        onChange={async (event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file !== undefined) await onSelect(file);
        }}
      />
      {preview !== null && (
        <DisabledTooltip reason={disabledReason} className="absolute -top-[7px] -right-[7px]">
          <button
            type="button"
            className={`${disabledReason === undefined ? "absolute -top-[7px] -right-[7px] " : ""}pointer-events-none grid size-[22px] cursor-pointer place-items-center rounded-full border bg-background text-muted-foreground opacity-0 transition-opacity duration-120 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-4 group-hover/icon-control:pointer-events-auto group-hover/icon-control:opacity-100 group-focus-within/icon-control:pointer-events-auto group-focus-within/icon-control:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100`}
            aria-label="Remove icon"
            title="Remove icon"
            disabled={disabled || disabledReason !== undefined}
            onClick={onRemove}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} aria-hidden />
          </button>
        </DisabledTooltip>
      )}
    </div>
  );
}
