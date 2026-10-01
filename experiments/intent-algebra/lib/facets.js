import path from "node:path";

const DISPLAY_NAMES = {
  assignment: "assignment",
  class: "class",
  comment: "comment",
  conditional_guard: "conditional guard",
  delimiter: "delimiter",
  exception: "exception",
  expression_statement: "expression statement",
  function: "function",
  function_call: "function call",
  identifier: "identifier",
  import: "import",
  literal: "literal",
  loop: "loop",
  named_argument: "named argument",
  object_property: "object property",
  return_value: "return value",
  unknown_construct: "unknown construct",
};

const ENTITY_PRIORITY = {
  conditional_guard: 100,
  exception: 95,
  function: 90,
  class: 90,
  named_argument: 85,
  object_property: 80,
  function_call: 75,
  import: 70,
  assignment: 65,
  return_value: 60,
  loop: 55,
  comment: 30,
  expression_statement: 20,
  literal: 15,
  identifier: 10,
  unknown_construct: 5,
  delimiter: 0,
};

const CONCEPT_STOPWORDS = new Set([
  "a", "add", "added", "allow", "an", "and", "api", "are", "as", "at", "be",
  "before", "by", "change", "changed", "check", "create", "default", "do", "does",
  "enable", "error", "existing", "fix", "for", "from", "function", "get", "if", "in",
  "index", "into", "is", "it", "js", "lib", "main", "make", "method", "missing", "new",
  "node", "not", "of", "on", "or", "py", "remove", "request", "return", "set", "src",
  "test", "tests", "that", "the", "this", "to", "update", "use", "used", "using", "when",
  "with",
]);

function normalizedTypes(action) {
  return new Set([
    action.node?.type,
    ...(action.subtree || []).map((node) => node.type),
  ].filter(Boolean));
}

function anyType(types, pattern) {
  return [...types].some((type) => pattern.test(type));
}

export function entityForAction(action) {
  const root = action.node?.type || "";
  const types = normalizedTypes(action);
  if (/^(?:if_statement|if_clause)$/.test(root)) return "conditional_guard";
  if (/^(?:raise_statement|throw_statement)$/.test(root)) return "exception";
  if (/(?:function|method)_(?:definition|declaration|expression)$/.test(root)) return "function";
  if (/class_(?:definition|declaration)$/.test(root)) return "class";
  if (/^(?:keyword_argument|default_parameter)$/.test(root)) return "named_argument";
  if (root === "pair") return "object_property";
  if (/^(?:import_statement|import_from_statement|import_clause|named_imports|dotted_name)$/.test(root)
    && anyType(types, /import|dotted_name/)) return "import";
  if (/^(?:assignment|assignment_expression|augmented_assignment|lexical_declaration|variable_declaration|variable_declarator)$/.test(root)) return "assignment";
  if (/^(?:return_statement)$/.test(root)) return "return_value";
  if (/^(?:for_statement|while_statement)$/.test(root)) return "loop";
  if (root === "comment") return "comment";
  if (/^(?:call|call_expression|new_expression)$/.test(root)
    || (root === "expression_statement" && anyType(types, /^(?:call|call_expression|new_expression)$/))) {
    return "function_call";
  }
  if (root === "expression_statement") return "expression_statement";
  if (/^(?:string|string_fragment|integer|float|number|true|false|null|none|literal)$/.test(root)) return "literal";
  if (/(?:identifier|name)$/.test(root)) return "identifier";
  if (/^(?:,|;|\.|:|\(|\)|\[|\]|\{|\})$/.test(root)) return "delimiter";
  if (anyType(types, /^(?:if_statement|if_clause)$/)) return "conditional_guard";
  if (anyType(types, /^(?:raise_statement|throw_statement)$/)) return "exception";
  if (anyType(types, /^(?:call|call_expression|new_expression)$/)) return "function_call";
  return "unknown_construct";
}

function containerForType(type) {
  if (/^(?:call|call_expression|new_expression|argument_list|arguments)$/.test(type)) return "function_call";
  if (/^(?:object|dictionary|pair)$/.test(type)) return "object_property";
  if (/^(?:if_statement|if_clause)$/.test(type)) return "conditional_guard";
  if (/(?:function|method)_(?:definition|declaration|expression)$/.test(type)) return "function";
  if (/class_(?:definition|declaration)$/.test(type)) return "class";
  if (/^(?:for_statement|while_statement)$/.test(type)) return "loop";
  if (/assignment|lexical_declaration|variable_declaration/.test(type)) return "assignment";
  return null;
}

export function containersForAction(action) {
  const ancestors = action.node?.ancestors || [];
  const containers = [];
  for (let index = 1; index < ancestors.length; index += 1) {
    const container = containerForType(ancestors[index].type);
    if (container && !containers.includes(container)) containers.push(container);
  }
  if (action.parent?.type) {
    const parent = containerForType(action.parent.type);
    if (parent && !containers.includes(parent)) containers.unshift(parent);
  }
  return containers;
}

function operationForAction(action) {
  const name = action.action || "";
  if (name.startsWith("insert")) return "insert";
  if (name.startsWith("delete")) return "delete";
  if (name.startsWith("update")) return "update";
  if (name.startsWith("move")) return "move";
  return "other";
}

function splitWords(value) {
  return String(value || "")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter((token) => token.length >= 2 && !/^\d+$/.test(token));
}

function usefulTokens(values) {
  return [...new Set(values.flatMap(splitWords)
    .filter((token) => !CONCEPT_STOPWORDS.has(token)))]
    .sort();
}

export function conceptTokens(result) {
  const subtreeLabels = (result.analysis?.actions || [])
    .flatMap((action) => action.subtree || [])
    .filter((node) => /(?:identifier|name|property_identifier|string|string_fragment|attribute)$/.test(node.type))
    .map((node) => node.label);
  const fileParts = String(result.file || "").split("/");
  const filename = path.posix.basename(result.file || "").replace(/\.[^.]+$/, "");
  return {
    changed_code: usefulTokens(subtreeLabels),
    file_path: usefulTokens([...fileParts, filename]),
    commit_subject: usefulTokens([result.subject]),
  };
}

export function deriveEditFacets(result) {
  const actions = result.analysis?.actions || [];
  const entities = [...new Set(actions.map(entityForAction))]
    .sort((left, right) => ENTITY_PRIORITY[right] - ENTITY_PRIORITY[left] || left.localeCompare(right));
  const containers = [...new Set(actions.flatMap(containersForAction))];
  const operations = [...new Set(actions.map(operationForAction))].sort();
  const primaryEntity = entities[0] || "unknown_construct";
  return {
    sample_id: result.sample_id,
    language: result.language,
    file: result.file,
    subject: result.subject,
    operations,
    primary_entity: primaryEntity,
    primary_entity_name: DISPLAY_NAMES[primaryEntity],
    entities: entities.map((id) => ({ id, name: DISPLAY_NAMES[id] })),
    containers: containers.map((id) => ({ id, name: DISPLAY_NAMES[id] })),
    concept_tokens: conceptTokens(result),
    ast_churn: result.ast_churn,
  };
}

export function entityDisplayName(entity) {
  return DISPLAY_NAMES[entity] || DISPLAY_NAMES.unknown_construct;
}
