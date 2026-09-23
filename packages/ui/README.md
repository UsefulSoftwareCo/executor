# Shared UI

Source-owned shadcn components for the local, cloud, and self-host dashboards.
This package owns shadcn controls, the theme, and the dashboard views developed
in the local product. Dashboard subpaths use SDK display types and Effect Atom.
They do not depend on a product server, authentication, or a router.

```tsx
import { Button } from "@executor-js/ui/components/button";
import { Dialog, DialogContent } from "@executor-js/ui/components/dialog";
```

The `/components/*` subpaths also let the shadcn CLI resolve the canonical
component directory from any dashboard. `src/index.ts` is the public barrel;
prefer subpath imports in apps. Custom public prop contracts live in
`src/contracts/`; standard React/Radix prop types stay next to each component.

Product styles import the shared stylesheet once, before their own layout:

```css
@import "@executor-js/ui/styles";
@source "../";
```

The shared stylesheet registers the component source with Tailwind and resolves
font assets relative to this package. Dashboard layouts use `@executor-js/ui/dashboard/styles`. Each frontend owns
its route tree and composes product-specific actions and identity controls. A plain semantic `aside`, `nav`, or a
domain-specific tool/file selection row does not need another wrapper. Radix
interaction primitives and their shared appearance belong here.

## Icons

Use the official Hugeicons React renderer and its free Stroke Rounded icons in
both shared controls and product pages. Import named icons directly; do not add
an icon registry or a second wrapper component.

```tsx
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";

<HugeiconsIcon icon={ArrowLeft02Icon} size={16} strokeWidth={2} aria-hidden />;
```

Named imports are tree-shakable. The current free pack does not publish the
type declarations required by its per-icon subpaths. Keep the existing sizes
and stroke weights when changing controls, hide decorative icons from assistive
technology, and use the shared Spinner for loading indicators. Navigation lists
store icon data and pass it to `HugeiconsIcon`; the data is not a React component.
Each dashboard's `components.json` selects Hugeicons for new shadcn components.

## Adding a component

From the repository root:

```sh
bunx shadcn@latest add separator --cwd packages/ui --dry-run
bunx shadcn@latest add separator --cwd packages/ui
```

Review generated imports and dependencies before keeping the result. Use our
existing `cn` helper from `@executor-js/ui/lib/utils` instead of adding a second
class helper. Keep internal imports relative or use this package's public
subpaths; do not use an app's `@/` alias. The dashboard `components.json` files
route shared UI additions to this same directory.

The initial components use shadcn's Radix sources (MIT license in
`LICENSE.shadcn`). Button retains Executor's stable-width loading state, Card
supports `asChild` for typed router links and articles, Dialog uses Button for
its close control, and radio menu items use a check mark. Business behavior stays
in the apps. Do not overwrite these adaptations without reviewing them.

## Dashboard views and atoms

Use `/dashboard/*` for Apps, Accounts, catalog/install, the app detail frame,
tool browser, account selection, credential/OAuth forms, and the sidebar shell.
These use the local dashboard's layout, icons, and responsive behavior.

`DashboardProvider` receives typed links and icon metadata. Each shared view
receives its query or mutation atom and a typed failure renderer as props.
`Query<A, E>`, `QueryProps<A, E>`, and `MutationProps<Input, A, E>` preserve the
operation's error union. There is no `unknown` error boundary or context cast.
Local supplies live SSE atoms; hosted binds its organization in the adapter.

```tsx
<DashboardProvider iconDomains={iconDomains} AppLink={AppLink} AccountLink={AccountLink}>
  <AppsPage
    query={atoms.inventory}
    Failure={InventoryFailure}
    action={canInstall ? <AddAppLink /> : undefined}
  />
</DashboardProvider>
```

The atom determines the error type. A renderer that cannot handle its complete
union is a type error. Products use exhaustive Effect matchers for expected
failures and safe copy for defects. Use `AsyncResult.isFailure` / `match`,
`Exit.isFailure`, and `Match.tag` / `tagsExhaustive`; do not read `_tag` directly.

The product decides whether to supply an action. The shared page knows only
its presentation. Server authorization remains required. Account forms receive
a submit operation that returns an Effect Exit; credentials are redacted before
submission and are never read back into the form.

See [code sharing](../../notes/code-sharing.md) for the adapter decision and
what remains separate.
