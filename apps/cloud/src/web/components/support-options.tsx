import { Button } from "@executor-js/react/components/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@executor-js/react/components/popover";

const supportLinks = [
  { label: "Discord", href: "https://discord.gg/eF29HBHwM6", icon: DiscordMark },
  {
    label: "GitHub Issues",
    href: "https://github.com/RhysSullivan/executor/issues",
    icon: GitHubMark,
  },
  { label: "Email", href: "mailto:rhys@executor.sh?subject=Executor%20support", icon: MailMark },
] as const;

export function SupportOptions() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="gap-2">
            <SlackMark className="size-4" />
            Slack
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72">
          <PopoverHeader>
            <PopoverTitle>Slack Connect</PopoverTitle>
            <PopoverDescription>
              Invite <span className="font-medium text-foreground">rhys@executor.sh</span> to Slack
              Connect.
            </PopoverDescription>
          </PopoverHeader>
        </PopoverContent>
      </Popover>
      {supportLinks.map((link) => (
        // oxlint-disable-next-line react/jsx-no-new-function-as-prop -- static support link component choice
        <a
          key={link.label}
          href={link.href}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 font-medium text-foreground transition-colors hover:bg-muted"
        >
          <link.icon className="size-4" />
          {link.label}
        </a>
      ))}
    </div>
  );
}

function DiscordMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M20.32 4.37A19.8 19.8 0 0 0 15.36 2.8a13.8 13.8 0 0 0-.64 1.32 18.4 18.4 0 0 0-5.44 0 13.8 13.8 0 0 0-.64-1.32 19.7 19.7 0 0 0-4.97 1.57C.53 9.09-.32 13.69.1 18.22a19.9 19.9 0 0 0 6.08 3.03 14.7 14.7 0 0 0 1.3-2.09 12.8 12.8 0 0 1-2.04-.97l.5-.38a14.2 14.2 0 0 0 12.12 0l.5.38c-.65.38-1.33.7-2.04.97.37.74.8 1.44 1.3 2.09a19.9 19.9 0 0 0 6.08-3.03c.5-5.25-.84-9.8-3.58-13.85ZM8.02 15.43c-1.18 0-2.15-1.08-2.15-2.4 0-1.33.95-2.41 2.15-2.41 1.2 0 2.17 1.09 2.15 2.4 0 1.33-.95 2.41-2.15 2.41Zm7.96 0c-1.18 0-2.15-1.08-2.15-2.4 0-1.33.95-2.41 2.15-2.41 1.2 0 2.17 1.09 2.15 2.4 0 1.33-.95 2.41-2.15 2.41Z" />
    </svg>
  );
}

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.15c-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.04 0 0 .98-.31 3.17 1.18a10.9 10.9 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.8 1.19 1.83 1.19 3.08 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.16c0 .31.21.67.79.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

function MailMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className={className}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 7l9 6 9-6M5 19h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2Z"
      />
    </svg>
  );
}

function SlackMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z"
        fill="#E01E5A"
      />
      <path
        d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.527 2.527 0 0 1 2.521 2.521 2.527 2.527 0 0 1-2.521 2.521H2.522A2.527 2.527 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z"
        fill="#36C5F0"
      />
      <path
        d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.272 0a2.528 2.528 0 0 1-2.521 2.521 2.527 2.527 0 0 1-2.521-2.521V2.522A2.527 2.527 0 0 1 15.163 0a2.528 2.528 0 0 1 2.521 2.522v6.312z"
        fill="#2EB67D"
      />
      <path
        d="M15.163 18.956a2.528 2.528 0 0 1 2.521 2.522A2.528 2.528 0 0 1 15.163 24a2.527 2.527 0 0 1-2.521-2.522v-2.522h2.521zm0-1.272a2.527 2.527 0 0 1-2.521-2.521 2.527 2.527 0 0 1 2.521-2.521h6.315A2.527 2.527 0 0 1 24 15.163a2.528 2.528 0 0 1-2.522 2.521h-6.315z"
        fill="#ECB22E"
      />
    </svg>
  );
}
