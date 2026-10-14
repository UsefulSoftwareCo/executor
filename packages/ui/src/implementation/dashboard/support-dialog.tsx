import { useId, useState, type ReactElement } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  DiscordIcon,
  GithubIcon,
  HelpCircleIcon,
  Mail01Icon,
  SlackIcon,
} from "@hugeicons/core-free-icons";
import { buttonVariants } from "../components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/dialog.tsx";
import { issuesUrl } from "./shell.tsx";

const supportAddress = "rhys@executor.sh";

const supportLinks = [
  { label: "Discord", href: "https://discord.gg/eF29HBHwM6", icon: DiscordIcon, external: true },
  { label: "GitHub Issues", href: issuesUrl, icon: GithubIcon, external: true },
  {
    label: "Email",
    href: `mailto:${supportAddress}?subject=Executor%20support`,
    icon: Mail01Icon,
    external: false,
  },
] as const;

/** A support channel whose link the user followed. */
export type SupportLink = (typeof supportLinks)[number]["label"];

const optionClass = buttonVariants({ variant: "outline", className: "justify-start" });

/**
 * A "Get support" entry for the sidebar's resource links, opening the ways to reach
 * the team. `trigger` replaces the sidebar entry where another element opens it. The owning
 * product records usage; this view does not choose an analytics sink.
 */
export function SupportDialog({
  onOpen,
  onLinkClick,
  trigger,
}: {
  readonly onOpen: () => void;
  readonly onLinkClick: (label: SupportLink) => void;
  readonly trigger?: ReactElement | undefined;
}) {
  const slackId = useId();
  const [slackOpen, setSlackOpen] = useState(false);
  return (
    <Dialog
      onOpenChange={(open) => {
        setSlackOpen(false);
        if (open) onOpen();
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            title="Get support"
            className="support-trigger cursor-pointer text-left hover:text-foreground"
          >
            <HugeiconsIcon icon={HelpCircleIcon} strokeWidth={2} size={13} aria-hidden />
            <span>Get support</span>
          </button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Get support</DialogTitle>
          <DialogDescription>Reach out through any of the channels below.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2 max-[380px]:grid-cols-1">
          {supportLinks.map(({ label, href, icon, external }) => (
            <a
              key={label}
              href={href}
              {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              className={optionClass}
              onClick={() => onLinkClick(label)}
            >
              <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden />
              {label}
            </a>
          ))}
          <button
            type="button"
            className={optionClass}
            aria-expanded={slackOpen}
            // The note exists only while expanded, so it is controlled only then.
            aria-controls={slackOpen ? slackId : undefined}
            onClick={() => setSlackOpen((open) => !open)}
          >
            <HugeiconsIcon icon={SlackIcon} strokeWidth={2} aria-hidden />
            Slack Connect
          </button>
        </div>
        {slackOpen && (
          <p
            id={slackId}
            className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
          >
            Invite <span className="font-medium text-foreground">{supportAddress}</span> to Slack
            Connect.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
