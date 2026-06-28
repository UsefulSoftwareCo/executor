---
"@executor-js/plugin-graphql": patch
---

Fix the GraphQL plugin generating invalid operations against large schemas. The auto-generated selection set no longer emits composite (object/connection) fields without a sub-selection, and no longer selects nested fields whose required arguments it cannot supply. Generated tools now validate against rich schemas (such as GitLab's) instead of failing on every call against a rich return type.
