import type {
  CaseStateView,
  DerivedNodeState,
  EdgeRecord,
  EdgeType,
  NodeRecord,
  RevisionSnapshot,
  ValidationIssue
} from "@casegraph/core";

const CHILD_EDGE_TYPES: ReadonlySet<EdgeType> = new Set(["depends_on", "waits_for"]);

export interface CaseViewData {
  case_id: string;
  revision: RevisionSnapshot;
  tree_lines: string[];
  nodes: NodeRecord[];
  edges: EdgeRecord[];
  derived: DerivedNodeState[];
  validation: ValidationIssue[];
}

export function buildCaseViewData(state: CaseStateView): CaseViewData {
  return {
    case_id: state.caseRecord.case_id,
    revision: state.caseRecord.case_revision,
    tree_lines: buildCaseTree(state),
    nodes: Array.from(state.nodes.values()).sort((a, b) => a.node_id.localeCompare(b.node_id)),
    edges: Array.from(state.edges.values()).sort((a, b) => a.edge_id.localeCompare(b.edge_id)),
    derived: Array.from(state.derived.values()).sort((a, b) => a.node_id.localeCompare(b.node_id)),
    validation: state.validation
  };
}

export function buildCaseTree(state: CaseStateView): string[] {
  if (state.nodes.size === 0) {
    return ["(empty case)"];
  }

  const childrenByNode = indexChildren(state);
  const rootIds = pickRoots(state, childrenByNode);
  const lines: string[] = [];
  const rendered = new Set<string>();

  for (const rootId of rootIds) {
    renderSubtree(rootId, [], state, childrenByNode, new Set<string>(), rendered, lines);
  }

  return lines;
}

function indexChildren(state: CaseStateView): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const edge of state.edges.values()) {
    if (!CHILD_EDGE_TYPES.has(edge.type)) {
      continue;
    }
    if (!(state.nodes.has(edge.source_id) && state.nodes.has(edge.target_id))) {
      continue;
    }
    const bucket = children.get(edge.target_id) ?? [];
    bucket.push(edge.source_id);
    children.set(edge.target_id, bucket);
  }
  for (const bucket of children.values()) {
    bucket.sort((a, b) => a.localeCompare(b));
  }
  return children;
}

function pickRoots(state: CaseStateView, childrenByNode: Map<string, string[]>): string[] {
  const reverseParents = new Map<string, Set<string>>();
  for (const [parentId, children] of childrenByNode) {
    for (const childId of children) {
      const parents = reverseParents.get(childId) ?? new Set<string>();
      parents.add(parentId);
      reverseParents.set(childId, parents);
    }
  }

  const goalRoots: string[] = [];
  const orphanRoots: string[] = [];
  for (const node of state.nodes.values()) {
    const hasParent = (reverseParents.get(node.node_id)?.size ?? 0) > 0;
    if (node.kind === "goal") {
      goalRoots.push(node.node_id);
      continue;
    }
    if (!hasParent) {
      orphanRoots.push(node.node_id);
    }
  }

  const roots = goalRoots.length > 0 ? [...goalRoots, ...orphanRoots] : orphanRoots;
  if (roots.length === 0) {
    roots.push(...Array.from(state.nodes.keys()));
  }
  return Array.from(new Set(roots)).sort((a, b) => a.localeCompare(b));
}

function renderSubtree(
  nodeId: string,
  prefixes: boolean[],
  state: CaseStateView,
  childrenByNode: Map<string, string[]>,
  stack: Set<string>,
  rendered: Set<string>,
  lines: string[]
): void {
  const node = state.nodes.get(nodeId);
  if (!node) {
    return;
  }

  const indent = prefixes
    .map((isLast, index) =>
      index === prefixes.length - 1 ? (isLast ? "└─ " : "├─ ") : isLast ? "   " : "│  "
    )
    .join("");

  if (stack.has(nodeId)) {
    lines.push(`${indent}· ${nodeId} (cycle)`);
    return;
  }

  if (rendered.has(nodeId)) {
    lines.push(`${indent}= ${nodeId} [${node.kind}/${node.state}] ${node.title} (shared)`);
    return;
  }

  const derived = state.derived.get(nodeId);
  const decorator = pickDecorator(node, derived);
  lines.push(`${indent}${decorator} ${nodeId} [${node.kind}/${node.state}] ${node.title}`);
  rendered.add(nodeId);

  const nextStack = new Set(stack);
  nextStack.add(nodeId);

  const children = childrenByNode.get(nodeId) ?? [];
  for (let i = 0; i < children.length; i += 1) {
    const childId = children[i] as string;
    const isLast = i === children.length - 1;
    renderSubtree(
      childId,
      [...prefixes, isLast],
      state,
      childrenByNode,
      nextStack,
      rendered,
      lines
    );
  }
}

function pickDecorator(node: NodeRecord, derived: DerivedNodeState | undefined): string {
  if (node.state === "done") {
    return "✓";
  }
  if (derived?.is_ready) {
    return "!";
  }
  if (derived && derived.waiting_for.length > 0) {
    return "→";
  }
  if (derived?.is_blocked) {
    return "✗";
  }
  return "·";
}
