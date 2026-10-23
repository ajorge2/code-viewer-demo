const diffEngine = globalThis.IntentTextDiff;

const elements = Object.fromEntries([
  "reviewer-id", "load-reviewer", "workspace", "previous", "next", "progress",
  "saved-count", "candidate-id", "candidate-title", "candidate-support", "pattern",
  "cluster-diagnostic", "relationships", "evidence", "review-form", "shared-concept", "suggestion-fieldset",
  "suggestions", "interpretation", "fit", "breadth", "confidence", "notes", "status",
].map((id) => [id, document.getElementById(id)]));

const state = { reviewerId: "", clusters: [], reviews: new Map(), index: 0 };

function addText(parent, tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text || "";
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function current() { return state.clusters[state.index]; }

function updateInterpretationFields() {
  const proposed = elements["shared-concept"].value === "yes";
  for (const element of [elements.interpretation, elements.fit, elements.breadth]) {
    element.required = proposed;
    element.disabled = !proposed;
    if (!proposed) element.value = "";
  }
  elements["suggestion-fieldset"].disabled = !proposed;
  if (!proposed) {
    for (const radio of elements.suggestions.querySelectorAll("input[type=radio]")) radio.checked = false;
  }
}

function selectedSuggestionId() {
  return elements.suggestions.querySelector("input[type=radio]:checked")?.value || "";
}

function renderSuggestions(cluster, selectedId = "") {
  elements.suggestions.replaceChildren();
  for (const suggestion of cluster.suggestions) {
    const label = document.createElement("label");
    label.className = "suggestion-card";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "suggestion";
    radio.value = suggestion.id;
    radio.checked = suggestion.id === selectedId;
    radio.addEventListener("change", () => { elements.interpretation.value = suggestion.label; });
    const copy = document.createElement("span");
    addText(copy, "strong", suggestion.label);
    addText(copy, "small", suggestion.description);
    label.append(radio, copy);
    elements.suggestions.append(label);
  }
  const custom = document.createElement("label");
  custom.className = "suggestion-card";
  const customRadio = document.createElement("input");
  customRadio.type = "radio";
  customRadio.name = "suggestion";
  customRadio.value = "";
  customRadio.checked = Boolean(selectedId === "" && elements.interpretation.value);
  const customCopy = document.createElement("span");
  addText(customCopy, "strong", "Custom interpretation");
  addText(customCopy, "small", "Write a different noun-level concept below.");
  custom.append(customRadio, customCopy);
  elements.suggestions.append(custom);
}

function fillReview(review = {}) {
  elements["shared-concept"].value = review.shared_concept || "";
  elements.interpretation.value = review.interpretation || "";
  elements.fit.value = review.fit || "";
  elements.breadth.value = review.breadth || "";
  elements.confidence.value = review.confidence || "";
  elements.notes.value = review.notes || "";
  renderSuggestions(current(), review.suggestion_id || "");
  updateInterpretationFields();
  elements.status.textContent = review.updated_at
    ? `Saved ${new Date(review.updated_at).toLocaleString()}`
    : "Not yet reviewed";
}

function renderSegments(parent, segments) {
  for (const segment of segments) {
    const token = document.createElement("span");
    token.className = `diff-token diff-token-${segment.kind}`;
    token.textContent = segment.text || " ";
    parent.append(token);
  }
}

function renderDiffCell(row, side) {
  const value = row[side];
  const cell = document.createElement("div");
  cell.className = `diff-cell diff-cell-${side} diff-cell-${row.kind}${value ? "" : " diff-cell-empty"}`;
  const number = addText(cell, "span", value?.number ?? "", "diff-line-number");
  number.setAttribute("aria-hidden", "true");
  const code = document.createElement("code");
  if (value) renderSegments(code, value.segments);
  cell.append(code);
  return cell;
}

function renderDiff(container, item, fullContext = false) {
  const result = diffEngine.buildSideBySideDiff(
    item.before_excerpt || "",
    item.after_excerpt || "",
    { context: fullContext ? Number.POSITIVE_INFINITY : 2 },
  );
  container.replaceChildren();
  const controls = document.createElement("div");
  controls.className = "diff-controls";
  addText(
    controls,
    "span",
    `+${result.stats.added} added · −${result.stats.removed} removed · ${result.stats.modified} modified`,
    "diff-summary",
  );
  const toggle = addText(controls, "button", fullContext ? "Collapse context" : "Show full context", "diff-toggle");
  toggle.type = "button";
  toggle.addEventListener("click", () => renderDiff(container, item, !fullContext));
  container.append(controls);

  const scroll = document.createElement("div");
  scroll.className = "diff-scroll";
  const table = document.createElement("div");
  table.className = "diff-table";
  const beforeHeading = addText(table, "div", "Before", "diff-column-heading diff-column-heading-before");
  const afterHeading = addText(table, "div", "After", "diff-column-heading diff-column-heading-after");
  beforeHeading.setAttribute("role", "columnheader");
  afterHeading.setAttribute("role", "columnheader");
  for (const row of result.rows) {
    if (row.kind === "skip") addText(table, "div", `⋯ ${row.count} unchanged lines ⋯`, "diff-skip");
    else table.append(renderDiffCell(row, "before"), renderDiffCell(row, "after"));
  }
  scroll.append(table);
  container.append(scroll);
}

function renderEvidence(evidence) {
  elements.evidence.replaceChildren();
  evidence.forEach((item, index) => {
    const article = document.createElement("article");
    article.className = "evidence-item";
    addText(
      article,
      "p",
      `Member ${index + 1} · ${item.language || "unknown"} · ${item.file || "unknown file"} · ${item.orthogonal_signature?.display || "unclassified relationship"} · medoid similarity ${Number(item.similarity_to_cluster_medoid).toFixed(2)}`,
      "metadata",
    );
    addText(article, "h3", item.subject || "No commit subject");
    const diff = document.createElement("div");
    diff.className = "diff-viewer";
    renderDiff(diff, item);
    article.append(diff);
    elements.evidence.append(article);
  });
}

function render() {
  const cluster = current();
  if (!cluster) return;
  elements.progress.textContent = `Cluster ${state.index + 1} of ${state.clusters.length}`;
  elements["saved-count"].textContent = `${state.reviews.size} saved by ${state.reviewerId}`;
  elements.previous.disabled = state.index === 0;
  elements.next.disabled = state.index === state.clusters.length - 1;
  elements["candidate-id"].textContent = cluster.cluster_id;
  elements["candidate-title"].textContent = cluster.label;
  elements["candidate-support"].textContent = `${cluster.support} members`;
  elements.pattern.replaceChildren();
  for (const term of cluster.terms.slice(0, 8)) addText(elements.pattern, "span", term.term);
  elements["cluster-diagnostic"].textContent =
    `Mean pairwise cosine similarity ${cluster.mean_pairwise_cosine_similarity.toFixed(2)} · `
    + `minimum ${cluster.minimum_pairwise_cosine_similarity.toFixed(2)}. `
    + "Similarity proposes the group; it does not prove a shared concept.";
  elements.relationships.replaceChildren();
  const recurring = cluster.orthogonal_relationships.filter((relationship) => relationship.support >= 2);
  const shownRelationships = recurring.length ? recurring : cluster.orthogonal_relationships.slice(0, 8);
  for (const relationship of shownRelationships) {
    const item = document.createElement("span");
    item.className = "relationship-chip";
    item.title = `Evidence: ${relationship.sample_ids.join(", ")}`;
    addText(item, "strong", relationship.display);
    addText(item, "small", `${relationship.support}/${cluster.support} member${relationship.support === 1 ? "" : "s"}`);
    elements.relationships.append(item);
  }
  if (!recurring.length) {
    addText(
      elements.relationships,
      "span",
      "No orthogonal link repeats yet; the cluster is semantic-only at this sample size.",
      "relationship-empty",
    );
  }
  renderEvidence(cluster.evidence);
  fillReview(state.reviews.get(cluster.cluster_id));
}

async function loadReviewer() {
  const reviewerId = elements["reviewer-id"].value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(reviewerId)) {
    elements["reviewer-id"].setCustomValidity("Use letters, numbers, dots, underscores, or hyphens.");
    elements["reviewer-id"].reportValidity();
    return;
  }
  elements["reviewer-id"].setCustomValidity("");
  const response = await fetch(`/api/clusters/state?reviewer_id=${encodeURIComponent(reviewerId)}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not load cluster review state");
  state.reviewerId = reviewerId;
  state.clusters = payload.clusters;
  state.reviews = new Map(payload.reviews.map((review) => [review.cluster_id, review]));
  state.index = Math.max(0, state.clusters.findIndex((cluster) => !state.reviews.has(cluster.cluster_id)));
  localStorage.setItem("intent-reviewer-id", reviewerId);
  elements.workspace.hidden = false;
  render();
}

async function saveReview(event) {
  event.preventDefault();
  const payload = {
    reviewer_id: state.reviewerId,
    cluster_id: current().cluster_id,
    shared_concept: elements["shared-concept"].value,
    suggestion_id: selectedSuggestionId(),
    interpretation: elements.interpretation.value,
    fit: elements.fit.value,
    breadth: elements.breadth.value,
    confidence: elements.confidence.value,
    notes: elements.notes.value,
  };
  elements.status.textContent = "Saving…";
  const response = await fetch("/api/clusters/reviews", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) {
    elements.status.textContent = result.error || "Interpretation could not be saved";
    return;
  }
  state.reviews.set(result.saved.cluster_id, result.saved);
  if (state.index < state.clusters.length - 1) state.index += 1;
  render();
}

elements["load-reviewer"].addEventListener("click", () => loadReviewer().catch((error) => {
  elements["reviewer-id"].setCustomValidity(error.message);
  elements["reviewer-id"].reportValidity();
}));
elements["review-form"].addEventListener("submit", saveReview);
elements.previous.addEventListener("click", () => { state.index -= 1; render(); window.scrollTo({ top: 0, behavior: "smooth" }); });
elements.next.addEventListener("click", () => { state.index += 1; render(); window.scrollTo({ top: 0, behavior: "smooth" }); });
elements["shared-concept"].addEventListener("change", updateInterpretationFields);
elements.interpretation.addEventListener("input", () => {
  const selected = elements.suggestions.querySelector("input[type=radio]:checked");
  const suggestion = current().suggestions.find((item) => item.id === selected?.value);
  if (suggestion && suggestion.label !== elements.interpretation.value) selected.checked = false;
});
elements["reviewer-id"].value = localStorage.getItem("intent-reviewer-id") || "";
