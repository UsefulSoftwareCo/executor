# Tree-sitter native builds with Node 24

Swagger ApiDOM pins tree-sitter 0.21.1 for JSON and 0.22.4 for YAML.
Both bindings request C++17. Node 24 headers require C++20, so a clean
Linux ARM installation fails when no prebuilt binding is available.
Warm caches and platforms with prebuilt bindings conceal the failure.

The patches select C++20 in the existing compiler settings on Linux,
macOS and Windows. They do not change parser code or skip installation.
Remove them when ApiDOM adopts bindings with compatible build settings.

Verification used Node 24.18.0 and node-gyp 13.0.2 in a Linux ARM container.
The unpatched 0.21.1 build failed at the Node header's C++20 requirement.
Both patched bindings built from source and loaded. The rebuilt JSON grammar
parsed a synthetic document without errors.
