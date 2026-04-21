import type {
  BlockedItem,
  DerivedNodeState,
  FrontierItem,
  NodeRecord
} from "@caphtech/casegraph-kernel";

type LeanNodeRecord = Omit<
  NodeRecord,
  "description" | "labels" | "acceptance" | "metadata" | "extensions"
> &
  Partial<Pick<NodeRecord, "description" | "labels" | "acceptance" | "metadata" | "extensions">>;

type LeanDerivedNodeState = Omit<DerivedNodeState, "node_id">;

export type LeanFrontierItem = LeanNodeRecord & { derived?: LeanDerivedNodeState };

export interface LeanBlockedItem {
  node: LeanNodeRecord;
  reasons: BlockedItem["reasons"];
}

function compactNodeRecord(node: NodeRecord): LeanNodeRecord {
  const lean: LeanNodeRecord = {
    node_id: node.node_id,
    kind: node.kind,
    title: node.title,
    state: node.state,
    created_at: node.created_at,
    updated_at: node.updated_at
  };
  if (node.description !== "") lean.description = node.description;
  if (node.labels.length > 0) lean.labels = node.labels;
  if (node.acceptance.length > 0) lean.acceptance = node.acceptance;
  if (Object.keys(node.metadata).length > 0) lean.metadata = node.metadata;
  if (Object.keys(node.extensions).length > 0) lean.extensions = node.extensions;
  return lean;
}

function isDerivedTrivial(derived: DerivedNodeState): boolean {
  return (
    derived.is_ready &&
    !derived.is_blocked &&
    derived.blockers.length === 0 &&
    derived.waiting_for.length === 0 &&
    derived.dependency_satisfied_ratio === 1 &&
    !derived.has_unverified_completion
  );
}

export function compactFrontierItem(item: FrontierItem): LeanFrontierItem {
  const { derived, ...node } = item;
  const lean: LeanFrontierItem = compactNodeRecord(node);
  if (!isDerivedTrivial(derived)) {
    const { node_id: _redundant, ...rest } = derived;
    lean.derived = rest;
  }
  return lean;
}

export function compactBlockedItem(item: BlockedItem): LeanBlockedItem {
  return {
    node: compactNodeRecord(item.node),
    reasons: item.reasons
  };
}
