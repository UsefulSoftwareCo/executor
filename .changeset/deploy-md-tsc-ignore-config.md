---
"@executor-js/app-templates": patch
---

The app-authoring skill's local type check pins TypeScript 7 and passes
`--ignoreConfig`, so it no longer fails with TS5112 in an app that has a
`tsconfig.json`. React UI files are checked with `--jsx react-jsx`, the UI
entry and a `ui/assets.d.ts` that declares CSS, image and font imports, instead
of a `tsconfig.json`. The skill names the React type packages the check needs.
