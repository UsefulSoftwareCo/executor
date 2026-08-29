---
"executor": patch
---

1Password: multiple named accounts. The provider now holds any number of named accounts — a work account next to a personal one, or a service-account token next to desktop-app biometrics — each scoping its own set of vaults. The settings card lists every account with independent edit and disconnect, existing single-account configs upgrade in place, and `op://` refs keep their vault-first addressing: a vault name that exists in more than one account is an explicit ambiguity error, never a silent pick.
