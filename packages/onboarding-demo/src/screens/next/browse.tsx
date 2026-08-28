// Reworked: the picker.
//
// Not a dialog behind a header button — the page itself. Search is the first
// thing on it, categories are chips under that, and every row adds in place:
// the row flips to "Added", the list does not move, and you can keep adding.
// Nothing here asks for a spec URL, a base URL or an auth method, because the
// registry already knows all three.
//
// "Add custom" sits next to the search box at all times, and the empty-search
// state leads with it rather than apologising — a URL that isn't in the
// registry is a normal thing to have, not a failed search.

import { useEffect, useMemo, useState } from "react";
import { CheckIcon, PlusIcon, SearchIcon } from "lucide-react";
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

/** Offered whenever the query cannot be satisfied from the registry — either
 *  because it looks like a URL, or because nothing matched. */
function CustomPrompt(props: { readonly query: string; readonly onAddCustom: () => void }) {
  const looksLikeUrl = /^[a-z]+:\/\//i.test(props.query) || props.query.includes("/");
  return (
    <div className="flex items-center gap-3 rounded-lg border border-dashed border-border px-3 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <PlusIcon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">
          {looksLikeUrl ? "Add this URL directly" : "Not in the registry?"}
        </p>
        <p className="text-xs text-muted-foreground">
          Point executor at any MCP server, OpenAPI spec, or GraphQL endpoint.
        </p>
      </div>
      <Button type="button" size="sm" className="shrink-0" onClick={props.onAddCustom}>
        Add custom
      </Button>
    </div>
  );
}

export function BrowsePage(props: {
  readonly addedDomains: readonly string[];
  readonly onAdd: (item: CatalogItem) => void;
  readonly onOpen: (item: CatalogItem) => void;
  readonly onAddCustom: () => void;
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
    <>
      <div className="mb-4 flex gap-2">
        <div className="relative min-w-0 flex-1">
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
        <Button
          type="button"
          variant="outline"
          className="h-11 shrink-0 gap-1.5"
          onClick={props.onAddCustom}
        >
          <PlusIcon className="size-4" aria-hidden />
          Add custom
        </Button>
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
          {searched.slice(0, 40).map((item) => (
            <CatalogRow
              key={item.domain}
              item={item}
              added={props.addedDomains.includes(item.domain)}
              onAdd={() => props.onAdd(item)}
              onOpen={() => props.onOpen(item)}
            />
          ))}
          <div className="mt-2">
            <CustomPrompt query={query} onAddCustom={props.onAddCustom} />
          </div>
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
    </>
  );
}
