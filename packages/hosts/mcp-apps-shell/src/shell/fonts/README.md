# Shell fonts

Geist and Geist Mono, subset to Latin + the punctuation and arrows a dashboard
actually renders, and vendored here as `woff2`.

They are vendored rather than loaded from Google Fonts because the inner
renderer's `srcDoc` runs under `font-src data:` — it may open no network
connection at all, by design (see `buildRendererSrcDoc` in `shell-app.tsx`). The
only way a branded typeface reaches model-written UI is as bytes inside the
document, so `globals.css` references these files and the shell's Vite build
inlines them as `data:` URLs (`build.assetsInlineLimit` in
`vite.config.shell.ts`). The shell's CSS is then copied into the `srcDoc`
verbatim, carrying the fonts with it.

Without this the shell falls back to `system-ui` and artifacts are the only
executor surface not set in Geist.

## Regenerating

Source: the `geist` npm package (v1.7.2), variable weights.

```sh
bun run --cwd packages/hosts/mcp-apps-shell fonts:subset
```

That script downloads the published package and re-subsets it. The subset range
is Latin-1 plus the arrows, bullets and dashes used in metric deltas and axis
labels; `tnum` is kept because the design system sets numbers in tabular
figures.
