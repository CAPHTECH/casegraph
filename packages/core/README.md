# @caphtech/casegraph-core

Node runtime and compatibility package for CaseGraph.

This package provides the local workspace, migration, JSON-RPC, plugin, and
SQLite runtime used by the CaseGraph CLI and built-in plugins.

It re-exports the pure `@caphtech/casegraph-kernel` surface for compatibility,
while keeping Node-only APIs such as workspace loading and plugin stdio hosting
here.

Topology analysis remains off the root public API and is exposed through:

```ts
import { analyzeTopology, analyzeTopologyForCase } from "@caphtech/casegraph-core/experimental";
```

Repository:

- https://github.com/CAPHTECH/casegraph
