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

const fetchSize = 32;

const productMark = (name: string | null): Mark | string | null => {
  if (name === null) return null;
  const mark = products.find(([pattern]) => pattern.test(name))?.[1];
  if (mark === undefined) return null;
  if (typeof mark !== "string") return mark;
  return mark.startsWith("/") ? mark : faviconUrl(mark, fetchSize);
};

export function AgentIcon({
  name,
  icon,
  className,
}: {
  readonly name: string | null;
  readonly icon: string | null;
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
