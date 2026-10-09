# Codemode on Effect 4 module paths

`@opencode-ai%2Fcodemode@0.0.0-dev-19272.patch` changes the five imports of
`effect/unstable/http` in the package's `OpenAPI` module to `effect/http`.

The prerelease was built against Effect `4.0.0-rc.112`. Effect 4 moved its
unstable modules to top-level paths and removed `effect/unstable/*`. The root
override runs codemode on the project's Effect, and its root entry re-exports
`OpenAPI`, so importing the package failed to resolve that path. Executor does
not call codemode's `OpenAPI` helpers; every other Effect API the package uses
exists unchanged in 4.0.1.

The patch changes only import specifiers in the published JavaScript and
declarations. Remove it when a codemode release imports Effect 4's public paths.
