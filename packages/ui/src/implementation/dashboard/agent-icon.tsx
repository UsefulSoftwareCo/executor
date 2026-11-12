import { createElement, useState } from "react";
import { RobotIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { faviconUrl } from "../../contracts/icons.ts";
import { cn } from "../lib/utils.ts";
import {
  ChatGptLogo,
  ClaudeLogo,
  CodexLogo,
  DevinLogo,
  GeminiLogo,
  GrokLogo,
  MuseLogo,
  OpenCodeLogo,
  WindsurfLogo,
  ZedLogo,
} from "./assistant-logos.tsx";

type Mark = typeof ClaudeLogo;

/**
 * Products an agent's name says it is, matched in order, ignoring case. A mark is one of the
 * dashboard's own logos, or the product's site, whose logo comes through the same proxy as provider
 * logos. Names are self-declared, so this says what an agent calls itself, never who it is.
 * Claude Code names itself `Claude Code (<server name>)`.
 */
const products: readonly (readonly [RegExp, Mark | string])[] = [
  [/^executor\b/iu, "/favicon.png"],
  [/\bclaude\b/iu, ClaudeLogo],
  [/\bcodex\b/iu, CodexLogo],
  [/\bchatgpt\b/iu, ChatGptLogo],
  [/\bopen ?code\b/iu, OpenCodeLogo],
  [/\bgrok\b/iu, GrokLogo],
  [/\bdevin\b/iu, DevinLogo],
  [/\bmuse\b/iu, MuseLogo],
  [/\bcursor\b/iu, "cursor.com"],
  [/^(?:oh-my-)?pi\b/iu, "pi.dev"],
  [/^amp\b/iu, "ampcode.com"],
  [/\bhermes\b/iu, "nousresearch.com"],
  [/\bantigravity\b/iu, "antigravity.google"],
  [/\bgemini\b/iu, GeminiLogo],
  [/\bwindsurf\b/iu, WindsurfLogo],
  [/\bzed\b/iu, ZedLogo],
  [/\bmanus\b/iu, "manus.im"],
  [/\bperplexity\b/iu, "perplexity.ai"],
  [/\bfactory\b/iu, "factory.ai"],
  [/\braycast\b/iu, "raycast.com"],
  [/\bconductor\b/iu, "conductor.build"],
  [/\bcapy\b/iu, "capy.ai"],
  [/\bpoke\b/iu, "poke.com"],
  [/\bkimi\b/iu, "kimi.com"],
  [/\bnotion\b/iu, "notion.so"],
];

/** The size proxy logos are fetched for; `faviconUrl` doubles it for 2x screens. */
const fetchSize = 32;

const productMark = (name: string | null): Mark | string | null => {
  if (name === null) return null;
  const mark = products.find(([pattern]) => pattern.test(name))?.[1];
  if (mark === undefined) return null;
  if (typeof mark !== "string") return mark;
  return mark.startsWith("/") ? mark : faviconUrl(mark, fetchSize);
};

/**
 * An agent's mark: the logo its client registered when it is an HTTPS URL, else the mark of the
 * product its name matches, else a robot. A logo that fails to load gives way to the next. Remote
 * images load only through an image element, without a referrer.
 */
export function AgentIcon({
  name,
  icon,
  className,
}: {
  readonly name: string | null;
  /** The logo URL the client registered, if any. */
  readonly icon: string | null;
  /** Sizes the mark; the robot draws at the same size. */
  readonly className?: string;
}) {
  const [failed, setFailed] = useState<readonly string[]>([]);
  const own = icon !== null && URL.canParse(icon) && new URL(icon).protocol === "https:";
  const mark = productMark(name);
  const sources = [...(own ? [icon] : []), ...(typeof mark === "string" ? [mark] : [])].filter(
    (source) => !failed.includes(source),
  );
  const source = sources[0];
  if (source !== undefined)
    return (
      <img
        key={source}
        src={source}
        alt=""
        aria-hidden
        referrerPolicy="no-referrer"
        className={cn("shrink-0 rounded-[3px] object-contain", className)}
        onError={() =>
          setFailed((current) => (current.includes(source) ? current : [...current, source]))
        }
      />
    );
  if (mark !== null && typeof mark !== "string")
    return createElement(mark, { className: cn("shrink-0", className), "aria-hidden": true });
  return (
    <HugeiconsIcon
      icon={RobotIcon}
      strokeWidth={2}
      className={cn("shrink-0", className)}
      aria-hidden
    />
  );
}
