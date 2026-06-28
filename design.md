---
version: alpha
name: Executor
description: Executor's design system. The integration layer for AI agents, drawn in a
  registry-grade minimal language: Geist and Geist Mono, a near-neutral grayscale ramp,
  hairline borders, and color held back to a single role. Semantic tokens carry one name
  and invert between Light and Dark; values below are the Light theme, with the Dark
  equivalent noted inline. Tokens are CSS custom properties in
  packages/react/src/styles/globals.css. Reference the token, never a raw literal.
colors:
  # Hierarchy comes from tone and hairlines, not hue. There is no brand color; the only
  # color in the system is destructive (red), and it is reserved for irreversible actions.
  background: "#ffffff"          # dark: #0a0a0a   page and app root
  foreground: "#111111"          # dark: #ededed   primary text and icons
  card: "#ffffff"                # dark: #0f0f0f   cards, dialogs, dropdowns, menus
  card-foreground: "#111111"     # dark: #ededed
  popover: "#ffffff"             # dark: #141414   surfaces stacked on other surfaces
  popover-foreground: "#111111"  # dark: #ededed
  primary: "#0a0a0a"             # dark: #ffffff   solid fill for the one key action
  primary-foreground: "#ffffff"  # dark: #0a0a0a
  secondary: "#fafafa"           # dark: #141414   quiet fills
  secondary-foreground: "#0a0a0a"# dark: #ededed
  muted: "#fafafa"               # dark: #141414
  muted-foreground: "#666666"    # dark: #9a9a9a   secondary text, metadata
  accent: "#f5f5f5"              # dark: #1a1a1a   hover and selected surface
  accent-foreground: "#0a0a0a"   # dark: #ededed
  destructive: "#b4261a"         # dark: #e0726a   errors and destructive actions
  border: "#eaeaea"              # dark: #1f1f1f   default hairline
  input: "#d4d4d4"               # dark: #333333   field stroke
  ring: "#888888"                # dark: #777777   focus
  sidebar: "#ffffff"             # dark: #0a0a0a   app chrome
  sidebar-foreground: "#666666"  # dark: #9a9a9a
  sidebar-border: "#eaeaea"      # dark: #1f1f1f
  sidebar-active: "#f5f5f5"      # dark: #141414   selected nav item
typography:
  # Geist sets UI and prose. Geist Mono sets code, tool slugs, IDs, counts, keyboard
  # shortcuts, section labels, and the wordmark. Keep to two weights per view (400, 500;
  # 600 for headings). font-display maps to Geist; headings are sans, the wordmark is mono.
  font-sans: "Geist, ui-sans-serif, system-ui, sans-serif"
  font-mono: "Geist Mono, ui-monospace, SF Mono, Menlo, monospace"
  font-display: "Geist, ui-sans-serif, system-ui, sans-serif"
  heading: { fontFamily: font-sans, fontSize: 17-50px, fontWeight: 600, tracking: -0.04em }
  body:    { fontFamily: font-sans, fontSize: 14-16px, fontWeight: 400, lineHeight: 1.55 }
  label:   { fontFamily: font-sans, fontSize: 13-14px, fontWeight: 500 }
  mono:    { fontFamily: font-mono, fontSize: 11-13px, fontWeight: 400 }
  sec-label: { fontFamily: font-mono, fontSize: 11px, fontWeight: 500, tracking: 0.08em, transform: uppercase, color: muted-foreground }
spacing:
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  6: 24px
  8: 32px
  10: 40px
  base: 4px
rounded:
  sm: 5px    # calc(radius * 0.6), inline controls
  md: 6px    # calc(radius * 0.8), buttons and inputs
  lg: 8px    # radius (0.5rem), cards and menus
  xl: 11px   # calc(radius * 1.4), large or overlay surfaces
  full: 9999px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 13px"
    height: 32px
  button-secondary:
    backgroundColor: transparent
    border: "1px solid {colors.input}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 13px"
    height: 32px
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.muted-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 11px"
    height: 32px           # tints to {colors.accent} on hover
  button-danger:
    backgroundColor: transparent
    border: "1px solid {colors.input}"
    textColor: "{colors.destructive}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 13px"
    height: 32px           # border tints to {colors.destructive} on hover
  input:
    backgroundColor: "{colors.background}"
    border: "1px solid {colors.input}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: 34px
  chip:
    backgroundColor: "{colors.secondary}"
    border: "1px solid {colors.border}"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.mono}"
    rounded: "{rounded.sm}"
    padding: "3px 9px"
  card:
    backgroundColor: "{colors.card}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.lg}"
    padding: "16px"
---

# Executor

## Overview

Executor is the integration layer for AI agents: one catalog of tools, auth, and policy
shared across every agent you use. The interface is calm and high-contrast, built so the
catalog stands out and the chrome disappears. Identity comes from restraint, not decoration:
Geist and Geist Mono, a near-neutral grayscale ramp, hairline borders, and a single column
framed by full-height guides. There is no brand color. The only color in the system is
destructive red, reserved for irreversible actions.

This document describes the Light theme. Executor uses one set of semantic token names that
redefine their values in Dark, so the same `bg-background` or `text-foreground` works in both
modes (system preference, with a `.dark` class override). Light values are the defaults above;
the Dark equivalent is noted inline after each token.

## Colors

Pick a surface by what an element is, not how it looks:

- `background` is the page and app root. `card` and `popover` are containers that sit on top
  of it (cards, dialogs, dropdowns, menus); in Dark, `popover` lifts one step above `card`.
- `sidebar` is the persistent chrome, one shade off `background`, with its own border and
  `sidebar-active` for the selected nav item.
- `secondary`, `muted`, and `accent` are quiet fills and hover or selected states, not general
  page backgrounds.
- `foreground` is primary text and icons; `muted-foreground` is secondary text, counts, and
  metadata.

Rank information with tone: `foreground` for primary text, `muted-foreground` for secondary,
`border` for separation. `primary` is a near-black solid (a white solid in Dark) used only for
the single most important action on a view. `destructive` is the one hue; pair it with text or
an icon, never signal state with color alone.

## Typography

Geist sets all UI and prose. Geist Mono sets code, tool slugs, IDs, counts, keyboard shortcuts,
section labels, and the wordmark. The wordmark `executor` is always Geist Mono. Section labels
are Geist Mono, 11px, uppercase, tracked `0.08em`, in `muted-foreground`: they carry metadata
and name sections without competing with headings. Headings are Geist 600 with tight tracking
(`-0.04em` at display sizes). Keep to no more than two weights per view, and apply the type
tokens rather than setting size, weight, or line height by hand.

## Layout

Spacing follows a 4px rhythm: 4, 8, 12, 16, 24, 32, 40px. Keep a three-step cadence: 8px inside
a group, 16px between groups, 32 to 40px between sections. Marketing and catalog surfaces center
a single column (around 1100px) with full-height hairline guides at the column edges, the
signature framing device; the app shell is a fixed sidebar plus a scrolling main pane. Every
view works from the 768px breakpoint up.

## Elevation and depth

Depth comes from tonal surfaces and hairlines first; shadows stay subtle. Separate a `card` from
the page with a 1px `border` and at most a soft shadow. Floating surfaces (menus, dialogs) may
add one diffuse shadow. In Dark, lift with a one-step-lighter surface (`card` to `popover`)
rather than a heavier shadow. Pair every elevation with the matching radius below.

## Motion

Motion clarifies a change; it is never decoration. Most interactions should feel instant, and
`0ms` is often the right call. When motion helps, keep it short and tokenized: about 150ms for
state changes, 200ms for popovers and tooltips, 300ms for overlays. Press feedback is a small
`scale(0.99)` on primary actions. Avoid looping or attention-grabbing animation, and always
honor `prefers-reduced-motion`.

## Shapes

Radii stay tight: 5px for inline controls, 6px for buttons and inputs, 8px for cards and menus,
11px for large or overlay surfaces. Reserve 9999px for pills, avatars, and dots. Keep one radius
family per view; do not mix rounded and sharp corners.

## Components

The `components` tokens above give ready-to-use values per element. Default control height is
32px (34px for inputs), suited to a dense catalog.

- Primary button: solid `primary` fill with `primary-foreground` label, for the single most
  important action on a view.
- Secondary button: transparent with a 1px `input` border and `foreground` text.
- Ghost button: transparent with `muted-foreground` text; tints to `accent` on hover. For
  low-emphasis and toolbar actions.
- Danger button: transparent with a 1px border and `destructive` text; border tints to
  `destructive` on hover. For irreversible actions.
- Input: `background` fill, 1px `input` border, 6px radius.
- Chip: `secondary` fill, 1px `border`, mono text, 5px radius. Used for kind tags
  (`MCP`, `API`, `GraphQL`, `CLI`) and counts.
- Card: `card` fill, 1px `border`, 8px radius, 16px padding.

Build new components the way the app already does: variants via `class-variance-authority`,
classes merged with `cn`, state on `data-*` attributes rather than ad-hoc classes. Show a focus
ring on every interactive element at `:focus-visible` (a `ring` outline with a small offset), and
never remove an outline without a visible replacement. Disabled drops to a `muted` fill,
`muted-foreground` text, and a not-allowed cursor.

## Marks and icons

Do not use a uniform icon pack (Tabler, Lucide, Heroicons) or monogram-in-rounded-square
placeholders: both read as generic, generated UI. Identity comes from authentic specifics or
from nothing at all.

- For a source or brand, use its real favicon
  (`https://www.google.com/s2/favicons?domain={host}&sz=64`), rendered at 18px with a 4px radius.
- For generic UI affordances (a select chevron, a checkbox tick), hand-draw them in CSS or a
  small inline SVG rather than pulling an icon font.
- Where a mark would only add noise, use none: type, mono metadata, and a status dot carry it.

## Voice and content

Copy is part of the design; keep it precise, technical, and free of filler.

- Title Case for labels, buttons, titles, and tabs; sentence case for body, helper text, and toasts.
- Name actions with a verb and a noun (`Add Source`, `Connect Agent`, `Revoke Token`), never
  `Confirm`, `OK`, or a bare verb.
- Write errors as what happened plus what to do next: `Couldn't reach the source. Check the
server is running, then retry.`
- Toasts name the specific thing that changed, drop the trailing period, and never say
  `successfully`: `Source added`, not `Successfully added the source.`
- Empty states point to the first action: `No sources yet. Add one to start sharing tools across
your agents.`
- Use the present participle with an ellipsis for in-progress states: `Connecting...`, `Syncing...`.
- Use numerals (`3 tools`), and skip `please` and marketing superlatives (avoid: powerful,
  seamless, robust, leverage, unlock, game-changing).

## For agents

Executor serves AI agents, so its own interface follows agent-friendly rules:

- The values above are the contract. Read a token; do not hardcode a hex literal or a raw size.
- No brand hue. If a design seems to need "another color," it is a role token at a different
  step, not a new hue.
- State lives on `data-*` attributes and semantic tokens, so a component can be reasoned about
  without parsing class soup.
- This file is the serialized design system. Keep it in sync with
  `packages/react/src/styles/globals.css`, which is the runtime source of truth.

## Do's and Don'ts

- Rank information with the gray ramp and hairlines, not color.
- Keep the near-black `primary` for the single most important action; one per view.
- Hold WCAG AA contrast (4.5:1 for body text).
- Apply the typography tokens instead of setting size, line height, or weight by hand.
- Use Geist Mono for the wordmark, section labels, counts, slugs, and shortcuts.
- Don't introduce a brand hue or a second accent; extend the neutral and semantic scales instead.
- Don't use an icon pack or monogram placeholders; use real favicons or nothing.
- Don't use `card` or `popover` as a page background, or `muted` and `accent` as a general fill.
- Don't mix rounded and sharp corners, or more than two font weights, in one view.
