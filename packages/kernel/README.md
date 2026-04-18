# @caphtech/casegraph-kernel

Pure kernel library for CaseGraph.

This package provides the deterministic graph logic, validation, reducer, patch
validation, and analysis primitives that the runtime packages build on.

Use this package when you want CaseGraph semantics without Node-specific
workspace, filesystem, SQLite, or plugin runtime concerns.

The topology analysis surface is available from the experimental entrypoint:

```ts
import { analyzeTopology } from "@caphtech/casegraph-kernel/experimental";
```

Repository:

- https://github.com/CAPHTECH/casegraph
