const diffEngine = globalThis.IntentTextDiff;

const elements = Object.fromEntries([
  "reviewer-id", "load-reviewer", "workspace", "previous", "next", "progress",
  "saved-count", "candidate-id", "candidate-title", "candidate-support", "pattern",
  "evidence", "review-form", "shared-intent", "output-meaning", "entailment",
  "specificity", "confidence", "notes", "status",
].map((id) => [id, document.getElementById(id)]));

const state = { reviewerId: "", candidates: [], reviews: new Map(), index: 0 };

function addText(parent, tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text || "";
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function current() { return state.candidates[state.index]; }

function updateMeaningFields() {
  const proposed = elements["shared-intent"].value === "yes";
  for (const element of [elements["output-meaning"], elements.entailment, elements.specificity]) {
    element.required = proposed;
    element.disabled = !proposed;
    if (!proposed) element.value = "";
  }
}

function fillReview(review = {}) {
  elements["shared-intent"].value = review.shared_intent || "";
  elements["output-meaning"].value = review.output_meaning || "";
  elements.entailment.value = review.entailment || "";
  elements.specificity.value = review.specificity || "";
  elements.confidence.value = review.confidence || "";
  elements.notes.value = review.notes || "";
  updateMeaningFields();
  elements.status.textContent = review.updated_at ? `Saved ${new Date(review.updated_at).toLocaleString()}` : "Not yet reviewed";
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
    if (row.kind === "skip") {
      addText(table, "div", `⋯ ${row.count} unchanged lines ⋯`, "diff-skip");
    } else {
      table.append(renderDiffCell(row, "before"), renderDiffCell(row, "after"));
    }
  }
  scroll.append(table);
  container.append(scroll);
}

function renderEvidence(evidence) {
  elements.evidence.replaceChildren();
  evidence.forEach((item, index) => {
    const article = document.createElement("article");
    article.className = "evidence-item";
    addText(article, "p", `Example ${index + 1} · ${item.language || "unknown"} · ${item.file || "unknown file"}`, "metadata");
    addText(article, "h3", item.subject || "No commit subject");
    if (item.message && item.message.trim() !== item.subject?.trim()) addText(article, "p", item.message.trim());
    const diff = document.createElement("div");
    diff.className = "diff-viewer";
    renderDiff(diff, item);
    article.append(diff);
    elements.evidence.append(article);
  });
}

function render() {
  const candidate = current();
  if (!candidate) return;
  elements.progress.textContent = `Candidate ${state.index + 1} of ${state.candidates.length}`;
  elements["saved-count"].textContent = `${state.reviews.size} saved by ${state.reviewerId}`;
  elements.previous.disabled = state.index === 0;
  elements.next.disabled = state.index === state.candidates.length - 1;
  elements["candidate-id"].textContent = candidate.candidate_id;
  elements["candidate-title"].textContent = "Does this structure express one shared human intent?";
  const support = candidate.support_in_pilot ?? candidate.support_in_139_graph_pilot;
  const denominator = candidate.pilot_graph_count ? ` / ${candidate.pilot_graph_count}` : "";
  elements["candidate-support"].textContent = `Pilot support ${support}${denominator}`;
  elements.pattern.replaceChildren();
  candidate.graph.nodes.forEach((node) => addText(elements.pattern, "span", node.label));
  renderEvidence(candidate.evidence);
  fillReview(state.reviews.get(candidate.candidate_id));
}

async function loadReviewer() {
  const reviewerId = elements["reviewer-id"].value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(reviewerId)) {
    elements["reviewer-id"].setCustomValidity("Use letters, numbers, dots, underscores, or hyphens.");
    elements["reviewer-id"].reportValidity();
    return;
  }
  elements["reviewer-id"].setCustomValidity("");
  const response = await fetch(`/api/state?reviewer_id=${encodeURIComponent(reviewerId)}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not load review state");
  state.reviewerId = reviewerId;
  state.candidates = payload.candidates;
  state.reviews = new Map(payload.reviews.map((review) => [review.candidate_id, review]));
  state.index = Math.max(0, state.candidates.findIndex((candidate) => !state.reviews.has(candidate.candidate_id)));
  localStorage.setItem("intent-reviewer-id", reviewerId);
  elements.workspace.hidden = false;
  render();
}

async function saveReview(event) {
  event.preventDefault();
  const payload = {
    reviewer_id: state.reviewerId,
    candidate_id: current().candidate_id,
    shared_intent: elements["shared-intent"].value,
    output_meaning: elements["output-meaning"].value,
    entailment: elements.entailment.value,
    specificity: elements.specificity.value,
    confidence: elements.confidence.value,
    notes: elements.notes.value,
  };
  elements.status.textContent = "Saving…";
  const response = await fetch("/api/reviews", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) {
    elements.status.textContent = result.error || "Review could not be saved";
    return;
  }
  state.reviews.set(result.saved.candidate_id, result.saved);
  if (state.index < state.candidates.length - 1) state.index += 1;
  render();
}

elements["load-reviewer"].addEventListener("click", () => loadReviewer().catch((error) => { elements["reviewer-id"].setCustomValidity(error.message); elements["reviewer-id"].reportValidity(); }));
elements["review-form"].addEventListener("submit", saveReview);
elements.previous.addEventListener("click", () => { state.index -= 1; render(); window.scrollTo({ top: 0, behavior: "smooth" }); });
elements.next.addEventListener("click", () => { state.index += 1; render(); window.scrollTo({ top: 0, behavior: "smooth" }); });
elements["shared-intent"].addEventListener("change", updateMeaningFields);

elements["reviewer-id"].value = localStorage.getItem("intent-reviewer-id") || "";
