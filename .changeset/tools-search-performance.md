---
"@executor-js/execution": patch
---

Optimize tools.search performance by precomputing query tokenization, using fast single-pass string normalization with Set lookups, scoping exact namespace enumerations to target integrations, and adding support for multi-namespace arrays and comma-separated slug lists.
