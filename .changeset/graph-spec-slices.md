---
"@executor-js/plugin-openapi": patch
---

Serve Microsoft Graph preset selections from precomputed slice release assets instead of the 43MB upstream monolith. The monolith fetch almost never survives a 128MB Workers isolate (production traces show one completion in 30 days), so covered selections — every catalog preset, plus any combination within the default bundle — now read a 4–19MB filtered document built offline by the graph-slices workflow, with the monolith path kept only as a fallback and for full-graph/custom-scope selections.
