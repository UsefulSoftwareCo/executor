---
executor: patch
---

Keep platform-specific CLI binary package versions below the matching wrapper version in SemVer order. Package managers that compare all versions of `executor` will continue selecting the installable wrapper instead of a platform binary variant.
