import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./button";
import { cn } from "../lib/utils";
import { copyToClipboard } from "../lib/clipboard";

function CopyButton({
  value,
  label,
  className,
  onCopy,
}: {
  value: string;
  label?: string;
  className?: string;
  /** Fires after a successful copy. Receives nothing — the copied value may be sensitive. */
  onCopy?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void copyToClipboard(value).then((ok) => {
      if (!ok) {
        toast.error("Failed to copy to clipboard");
        return;
      }
      setCopied(true);
      onCopy?.();
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (label) {
    return (
      <Button
        variant="ghost"
        size="xs"
        onClick={handleCopy}
        className={cn("text-muted-foreground", className)}
        title={label}
      >
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : label}
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={handleCopy}
      className={cn("shrink-0 text-muted-foreground", className)}
      title="Copy"
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

export { CopyButton };
