import { Atom, AsyncResult } from "effect/reactivity";
import { Option } from "effect";
import { getDomain } from "tldts";
import type { CatalogIcon, CatalogListing } from "@executor-js/catalog/contracts";
import type { AppRequirements } from "@executor-js/sdk";
import type { Query } from "./dashboard.ts";

export const faviconUrl = (url: string | null | undefined, size: number): string | null => {
  if (!url) return null;
  const domain = getDomain(url) ?? (URL.canParse(url) ? getDomain(new URL(url).hostname) : null);
  return domain === null ? null : `https://integrations.sh/logo/${domain}?sz=${size * 2}`;
};

export interface CatalogIcons {
  readonly settled: boolean;
  readonly byPackage: ReadonlyMap<string, readonly CatalogIcon[]>;
  readonly byName: ReadonlyMap<string, readonly CatalogIcon[] | null>;
}

export const noCatalogIcons: CatalogIcons = {
  settled: true,
  byPackage: new Map(),
  byName: new Map(),
};

const unsettledCatalogIcons: CatalogIcons = {
  settled: false,
  byPackage: new Map(),
  byName: new Map(),
};

export const catalogIconsAtom = <E>(catalogAtom: Query<CatalogListing, E>) =>
  Atom.make((get): CatalogIcons => {
    const result = get(catalogAtom);
    const settled = AsyncResult.isSuccess(result) || AsyncResult.isFailure(result);
    const byPackage = new Map<string, readonly CatalogIcon[]>();
    const byName = new Map<string, readonly CatalogIcon[] | null>();
    const catalog = AsyncResult.value(result);
    if (Option.isSome(catalog))
      for (const entry of catalog.value.apps) {
        if (entry.icons.length === 0) continue;
        byPackage.set(entry.package, entry.icons);
        const name = entry.name.trim().toLowerCase();
        byName.set(name, byName.has(name) ? null : entry.icons);
      }
    return { settled, byPackage, byName };
  }).pipe(Atom.withServerValue(() => unsettledCatalogIcons));

export interface AppIconSources {
  readonly light: string;
  readonly dark: string;
}

const loadable = (src: string) =>
  /^data:image\/(?:svg\+xml|png|webp|jpeg)[;,]/u.test(src) ||
  (URL.canParse(src) && new URL(src).protocol === "https:");

const themedSources = (
  icons: readonly { readonly src: string; readonly theme?: "light" | "dark" }[],
): AppIconSources | null => {
  const pick = (theme: "light" | "dark") =>
    (
      icons.find((icon) => icon.theme === theme) ??
      icons.find((icon) => icon.theme === undefined) ??
      icons[0]
    )?.src;
  const light = pick("light");
  const dark = pick("dark");
  return light === undefined || dark === undefined ? null : { light, dark };
};

export const appIconSources = (icons: AppRequirements["icons"]): AppIconSources | null =>
  themedSources((icons ?? []).filter((icon) => loadable(icon.src)));

export const catalogIconSources = (
  icons: readonly CatalogIcon[] | undefined,
): AppIconSources | null => themedSources(icons ?? []);
