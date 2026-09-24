# ApiDOM 3.1 initialization in bundled Workers

`swagger-client@3.38.2` uses `@swagger-api/apidom-ns-openapi-3-1@1.11.6`.
Its root barrel re-exports element classes through `refractor/registration`.
That registration assigns each class's static `refract` function.

The package marks registration as side-effectful but marks its root barrel as
side-effect-free. In Alchemy's Rolldown output, the registration initializer
exists but is never called. `OpenApi3_1Element.refract` then calls the inherited
generic object refractor. Reference resolution returns unresolved objects with
an empty error list. The same failure occurs when running that bundle in Node;
it is not specific to workerd or minification.

The patch includes both root entry points in `sideEffects`. It changes no
resolver behavior. The import-to-wire fixture must resolve a 3.1 component
parameter and produce a matrix path in a bundled Worker. Removing the two lines
must fail that assertion. Keep the patch until an upstream release fixes the
metadata or the bundler preserves this initialization without it.

No upstream issue or PR has been submitted from this change.
