import { createHash } from "node:crypto";
import path from "node:path";

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pipfile.lock",
]);

const NOISY_PATH_SEGMENTS = new Set([
  "node_modules",
  "vendor",
  "vendors",
  "third_party",
  "dist",
  "build",
  "coverage",
  "generated",
  "fixtures",
  "snapshots",
  "__snapshots__",
]);

const GENERATED_HEADER = /(?:auto[- ]?generated|generated (?:file|code)|do not edit|machine generated)/i;
const BOUNDARY_TYPES = new Set([
  "assignment",
  "augmented_assignment",
  "expression_statement",
  "return_statement",
  "raise_statement",
  "assert_statement",
  "pass_statement",
  "break_statement",
  "continue_statement",
  "import_statement",
  "import_from_statement",
  "if_statement",
  "for_statement",
  "while_statement",
  "try_statement",
  "with_statement",
  "match_statement",
  "function_definition",
  "class_definition",
  "decorated_definition",
  "lexical_declaration",
  "variable_declaration",
  "variable_declarator",
  "export_statement",
  "throw_statement",
  "switch_statement",
  "function_declaration",
  "class_declaration",
  "method_definition",
  "formal_parameters",
  "parameters",
]);

const ROOT_TYPES = new Set(["module", "program"]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function cheapExclusionReason(row, language) {
  const file = String(row.new_file || row.old_file || "").replaceAll("\\", "/");
  const basename = path.posix.basename(file).toLowerCase();
  const segments = file.toLowerCase().split("/");
  const oldContents = row.old_contents ?? "";
  const newContents = row.new_contents ?? "";

  if (!oldContents) return "file_addition";
  if (!newContents) return "file_deletion";
  if (oldContents === newContents) return "unchanged";
  if (LOCKFILES.has(basename)) return "lockfile";
  if (segments.some((segment) => NOISY_PATH_SEGMENTS.has(segment))) return "noisy_path";
  if (/\.(?:min|bundle)(?:\.[a-f0-9]{6,})?\.js$/i.test(basename)) return "minified_or_bundle";
  if (/(?:^|[._-])(?:generated|gen)(?:[._-]|$)/i.test(basename)) return "generated_name";
  if (GENERATED_HEADER.test(newContents.slice(0, 800))) return "generated_header";
  if (language === "python" && !basename.endsWith(".py")) return "wrong_extension";
  if (language === "javascript" && !/\.(?:js|mjs|cjs|jsx)$/.test(basename)) return "wrong_extension";

  const lines = newContents.split("\n");
  const maxLine = lines.reduce((maximum, line) => Math.max(maximum, line.length), 0);
  if (newContents.length > 2_000 && lines.length < 5 && maxLine > 1_000) return "minified_content";
  return null;
}

export function canonicalPatchHash(row) {
  return sha256(`${row.old_contents}\u0000${row.new_contents}`);
}

export function deterministicSample(rows, limit) {
  if (!Number.isInteger(limit) || limit < 1 || rows.length <= limit) {
    return [...rows].sort((a, b) => a.sample_key.localeCompare(b.sample_key));
  }
  return [...rows]
    .sort((a, b) => a.sample_key.localeCompare(b.sample_key))
    .slice(0, limit);
}

function isBoundaryType(type) {
  return BOUNDARY_TYPES.has(type)
    || /(?:_statement|_declaration|_definition)$/.test(type);
}

export function selectComponentAnchor(action) {
  const ancestors = action.node?.ancestors || [];
  for (const ancestor of ancestors) {
    if (isBoundaryType(ancestor.type)) return { ...ancestor, side: action.side };
  }

  const fallback = ancestors.find((ancestor) => !ROOT_TYPES.has(ancestor.type))
    || ancestors[0]
    || action.node;
  return { ...fallback, side: action.side };
}

export function groupEditComponents(actions) {
  const components = new Map();
  actions.forEach((action, actionIndex) => {
    const anchor = selectComponentAnchor(action);
    const key = `${anchor.side}:${anchor.type}:${anchor.start}:${anchor.end}`;
    if (!components.has(key)) {
      components.set(key, {
        id: key,
        side: anchor.side,
        type: anchor.type,
        start: anchor.start,
        end: anchor.end,
        action_indexes: [],
      });
    }
    components.get(key).action_indexes.push(actionIndex);
  });
  return [...components.values()].sort((left, right) =>
    left.side.localeCompare(right.side) || left.start - right.start || left.end - right.end);
}

function actionNodeWeight(action) {
  return action.action?.endsWith("-tree")
    ? Math.max(1, action.subtree?.length || 0)
    : 1;
}

export function summarizeAstChurn(actions) {
  const churn = {
    added_nodes: 0,
    removed_nodes: 0,
    inserted_actions: 0,
    deleted_actions: 0,
    updated_actions: 0,
    moved_actions: 0,
    other_actions: 0,
  };
  for (const action of actions || []) {
    const name = action.action || "";
    if (name.startsWith("insert")) {
      churn.added_nodes += actionNodeWeight(action);
      churn.inserted_actions += 1;
    } else if (name.startsWith("delete")) {
      churn.removed_nodes += actionNodeWeight(action);
      churn.deleted_actions += 1;
    } else if (name.startsWith("update")) {
      // An update replaces one AST node, so it contributes equally to both sides.
      churn.added_nodes += 1;
      churn.removed_nodes += 1;
      churn.updated_actions += 1;
    } else if (name.startsWith("move")) {
      churn.moved_actions += 1;
    } else {
      churn.other_actions += 1;
    }
  }
  return {
    ...churn,
    net_added_nodes: churn.added_nodes - churn.removed_nodes,
    removal_to_addition_ratio: churn.added_nodes
      ? churn.removed_nodes / churn.added_nodes
      : null,
  };
}

export function isAdditionDominant(churn, { minAddedNodes = 2, maxRemovalRatio = 0.25 } = {}) {
  return churn.added_nodes >= minAddedNodes
    && churn.removal_to_addition_ratio !== null
    && churn.removal_to_addition_ratio <= maxRemovalRatio;
}

export function analysisExcerpts(analysis, beforeSource, afterSource) {
  const beforeNodes = [];
  const afterNodes = [];
  for (const action of analysis.actions || []) {
    if (action.side === "before") {
      beforeNodes.push(action.node);
      if (action.mapped_node) afterNodes.push(action.mapped_node);
    } else {
      afterNodes.push(action.node);
      if (action.parent) beforeNodes.push(action.parent);
    }
  }
  const unique = (nodes) => [...new Map(nodes
    .filter(Boolean)
    .map((node) => [`${node.start}:${node.end}`, node])).values()]
    .sort((left, right) => left.start - right.start)
    .slice(0, 4);
  return {
    before: unique(beforeNodes).map((node) => codeExcerpt(beforeSource, node.start, node.end)).join("\n---\n"),
    after: unique(afterNodes).map((node) => codeExcerpt(afterSource, node.start, node.end)).join("\n---\n"),
  };
}

function normalizedLabel(node) {
  const type = node?.type || "unknown";
  if (/(?:identifier|name|property_identifier)$/.test(type)) return "$ID";
  if (/(?:string|integer|float|number|true|false|null|none|literal)$/.test(type)) return "$LIT";
  return node?.label || "";
}

function canonicalSubtree(action) {
  return (action.subtree || [{ id: 0, parent: -1, ...action.node }])
    .map((node) => `${node.parent}:${node.type}:${normalizedLabel(node)}`)
    .join(";");
}

export function structuralSignature(analysis, components) {
  const componentTokens = components.map((component) => {
    const actionTokens = component.action_indexes.map((index) => {
      const action = analysis.actions[index];
      return [action.action, action.node.type, normalizedLabel(action.node), canonicalSubtree(action)].join(":");
    }).sort();
    return `${component.side}:${component.type}[${actionTokens.join(",")}]`;
  }).sort();
  return sha256(componentTokens.join("|"));
}

export function codeExcerpt(source, start, end, padding = 100, maximum = 1_200) {
  const from = Math.max(0, Number.isFinite(start) ? start - padding : 0);
  const to = Math.min(source.length, Number.isFinite(end) ? end + padding : maximum);
  const excerpt = source.slice(from, to);
  return excerpt.length <= maximum ? excerpt : `${excerpt.slice(0, maximum)}\n…`;
}

export function graphForResult(result) {
  const vertices = [];
  const edges = [];
  const vertexIds = new Map();

  const addVertex = (key, label) => {
    if (!vertexIds.has(key)) {
      vertexIds.set(key, vertices.length);
      vertices.push({ id: vertices.length, label });
    }
    return vertexIds.get(key);
  };

  result.analysis.actions.forEach((action, actionIndex) => {
    const actionId = addVertex(`action:${actionIndex}`, `action:${action.action}`);
    const anchor = selectComponentAnchor(action);
    let previous = null;
    for (const ancestor of action.node.ancestors || []) {
      const key = `${action.side}:${ancestor.type}:${ancestor.start}:${ancestor.end}`;
      const nodeId = addVertex(key, `${action.side}:${ancestor.type}`);
      if (previous === null) edges.push({ from: actionId, to: nodeId, label: "affects" });
      else edges.push({ from: previous, to: nodeId, label: "parent" });
      previous = nodeId;
      if (ancestor.type === anchor.type && ancestor.start === anchor.start && ancestor.end === anchor.end) break;
    }

    for (const node of action.subtree || []) {
      const nodeId = addVertex(
        `subtree:${actionIndex}:${node.id}`,
        `${action.side}:${node.type}:${normalizedLabel(node)}`,
      );
      if (node.parent === -1) edges.push({ from: actionId, to: nodeId, label: "edit-root" });
      else {
        const parentId = vertexIds.get(`subtree:${actionIndex}:${node.parent}`);
        edges.push({ from: parentId, to: nodeId, label: "child" });
      }
    }
  });

  return { id: result.sample_id, vertices, edges };
}

export function renderGSpan(graphs) {
  // The selected miner consumes undirected graphs. Reify every directed edge as a
  // relation vertex with distinct source/target edge labels so direction survives.
  const miningGraphs = graphs.map((graph) => {
    const vertices = graph.vertices.map((vertex) => ({ ...vertex }));
    const edges = [];
    for (const edge of graph.edges) {
      const relationId = vertices.length;
      vertices.push({ id: relationId, label: `relation:${edge.label}` });
      edges.push({ from: edge.from, to: relationId, label: "source" });
      edges.push({ from: relationId, to: edge.to, label: "target" });
    }
    return { ...graph, vertices, edges };
  });
  const vertexLabels = [...new Set(miningGraphs.flatMap((graph) => graph.vertices.map((vertex) => vertex.label)))].sort();
  const edgeLabels = [...new Set(miningGraphs.flatMap((graph) => graph.edges.map((edge) => edge.label)))].sort();
  // The gSpan backend reserves 0/1, so label ids begin at 2.
  const vertexLabelIds = new Map(vertexLabels.map((label, index) => [label, index + 2]));
  const edgeLabelIds = new Map(edgeLabels.map((label, index) => [label, index + 2]));
  const lines = [];

  miningGraphs.forEach((graph, index) => {
    lines.push(`t # ${index}`);
    graph.vertices.forEach((vertex) => lines.push(`v ${vertex.id} ${vertexLabelIds.get(vertex.label)}`));
    graph.edges.forEach((edge) => lines.push(`e ${edge.from} ${edge.to} ${edgeLabelIds.get(edge.label)}`));
  });
  lines.push("t # -1");
  return {
    text: `${lines.join("\n")}\n`,
    labels: {
      vertices: Object.fromEntries(vertexLabels.map((label, index) => [index + 2, label])),
      edges: Object.fromEntries(edgeLabels.map((label, index) => [index + 2, label])),
    },
  };
}
