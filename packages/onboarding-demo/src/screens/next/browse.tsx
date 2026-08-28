// Reworked: the picker.
//
// Not a dialog behind a header button — the workspace's front door. Search is
// the first thing on the page, categories are chips under it, and every row
// adds in place: the row flips to "Added", the list does not move, and you can
// keep adding. Nothing here asks for a spec URL, a base URL or an auth method,
// because the registry already knows all three.

import { useEffect, useMemo, useState } from "react";
import { CheckIcon, SearchIcon } from "lucide-react";
import { Button } from "@executor-js/react/components/button";
import { Input } from "@executor-js/react/components/input";
import { Skeleton } from "@executor-js/react/components/skeleton";
import { cn } from "@executor-js/react/lib/utils";
import { CATEGORY_ORDER, loadCatalog, searchItems, type CatalogItem } from "../../catalog";

const SECTION_SIZE = 6;

function AddButton(props: { readonly added: boolean; readonly onAdd: () => void }) {
  if (props.added) {
    return (
      <span className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-muted-foreground">
        <CheckIcon className="size-3.5" aria-hidden />
        Added
      </span>
    );
  }
  return (
    <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={props.onAdd}>
      Add
    </Button>
  );
}

function CatalogRow(props: {
  readonly item: CatalogItem;
  readonly added: boolean;
  readonly onAdd: () => void;
  readonly onOpen: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
        props.added ? "border-ring/40 bg-accent/40" : "border-transparent hover:bg-accent/40",
      )}
    >
      {/* oxlint-disable-next-line react/forbid-elements */}
      <button
        type="button"
        onClick={props.onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <img
          src={props.item.icon}
          alt=""
          loading="lazy"
          className="size-8 shrink-0 rounded-md object-contain"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {props.item.name}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {props.item.description}
          </span>
        </span>
      </button>
      <AddButton added={props.added} onAdd={props.onAdd} />
    </div>
  );
}

export function BrowsePage(props: {
  readonly addedDomains: readonly string[];
  readonly onAdd: (item: CatalogItem) => void;
  readonly onOpen: (item: CatalogItem) => void;
}) {
  const [items, setItems] = useState<readonly CatalogItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("All");

  useEffect(() => {
    let live = true;
    void loadCatalog().then((loaded) => {
      if (live) setItems(loaded);
    });
    return () => {
      live = false;
    };
  }, []);

  const searched = useMemo(() => (items ? searchItems(items, query) : []), [items, query]);

  // Searching flattens: when someone types, one ranked list is the answer, not
  // the same query re-asked per section.
  const searching = query.trim().length > 0;

  const sections = useMemo(() => {
    if (searching) return [];
    const wanted = category === "All" ? CATEGORY_ORDER : [category];
    return wanted
      .map((name) => ({
        name,
        items: searched.filter((item) => item.category === name).slice(0, SECTION_SIZE),
      }))
      .filter((section) => section.items.length > 0);
  }, [searched, category, searching]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10 lg:px-8">
        <div className="mb-6 flex items-baseline justify-between gap-4">
          <h1 className="font-display text-[2rem] leading-none tracking-tight text-foreground">
            Add integrations
          </h1>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {props.addedDomains.length} added
            {items ? ` · ${items.length.toLocaleString()} available` : ""}
          </span>
        </div>

        <div className="relative mb-4">
          <SearchIcon
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(event) => setQuery((event.target as HTMLInputElement).value)}
            placeholder="Search integrations…"
            aria-label="Search integrations"
            className="h-11 pl-9 text-sm"
          />
        </div>

        <div className="mb-8 flex flex-wrap gap-1.5">
          {["All", ...CATEGORY_ORDER].map((name) => (
            // oxlint-disable-next-line react/forbid-elements
            <button
              key={name}
              type="button"
              onClick={() => setCategory(name)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                category === name
                  ? "border-foreground/20 bg-foreground text-background"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {name}
            </button>
          ))}
        </div>

        {items === null ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2.5">
                <Skeleton className="size-8 shrink-0 rounded-md" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5" style={{ width: `${20 + ((i * 11) % 20)}%` }} />
                  <Skeleton className="h-3" style={{ width: `${45 + ((i * 13) % 30)}%` }} />
                </div>
                <Skeleton className="h-8 w-14 rounded-md" />
              </div>
            ))}
          </div>
        ) : searching ? (
          <div className="flex flex-col gap-1">
            {searched.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Nothing in the registry matches “{query}”.
              </p>
            ) : (
              searched
                .slice(0, 40)
                .map((item) => (
                  <CatalogRow
                    key={item.domain}
                    item={item}
                    added={props.addedDomains.includes(item.domain)}
                    onAdd={() => props.onAdd(item)}
                    onOpen={() => props.onOpen(item)}
                  />
                ))
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-8">
            {sections.map((section) => (
              <section key={section.name}>
                <h2 className="mb-2 px-3 text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  {section.name}
                </h2>
                <div className="flex flex-col gap-1">
                  {section.items.map((item) => (
                    <CatalogRow
                      key={item.domain}
                      item={item}
                      added={props.addedDomains.includes(item.domain)}
                      onAdd={() => props.onAdd(item)}
                      onOpen={() => props.onOpen(item)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
