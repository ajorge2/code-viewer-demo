function lcsOperations(before, after) {
  const rows = before.length + 1;
  const columns = after.length + 1;
  const table = Array.from({ length: rows }, () => new Uint32Array(columns));
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      table[left][right] = before[left] === after[right]
        ? table[left + 1][right + 1] + 1
        : Math.max(table[left + 1][right], table[left][right + 1]);
    }
  }

  const operations = [];
  let left = 0;
  let right = 0;
  while (left < before.length || right < after.length) {
    if (left < before.length && right < after.length && before[left] === after[right]) {
      operations.push({ kind: "equal", before: before[left], after: after[right] });
      left += 1;
      right += 1;
    } else if (right >= after.length
      || (left < before.length && table[left + 1][right] >= table[left][right + 1])) {
      operations.push({ kind: "delete", before: before[left] });
      left += 1;
    } else {
      operations.push({ kind: "insert", after: after[right] });
      right += 1;
    }
  }
  return operations;
}

function tokenize(line) {
  return line.match(/\s+|[\p{L}_$][\p{L}\p{N}_$]*|\d+(?:\.\d+)?|./gu) || [];
}

function mergeSegments(segments) {
  const merged = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (previous?.kind === segment.kind) previous.text += segment.text;
    else merged.push({ ...segment });
  }
  return merged;
}

function diffLineTokens(beforeLine, afterLine) {
  const operations = lcsOperations(tokenize(beforeLine), tokenize(afterLine));
  return {
    before: mergeSegments(operations
      .filter((operation) => operation.kind !== "insert")
      .map((operation) => ({ kind: operation.kind, text: operation.before }))),
    after: mergeSegments(operations
      .filter((operation) => operation.kind !== "delete")
      .map((operation) => ({ kind: operation.kind, text: operation.after }))),
  };
}

function line(text, number, segments) {
  return { number, text, segments };
}

function collapseContext(rows, context) {
  if (!Number.isFinite(context)) return rows;
  const output = [];
  for (let index = 0; index < rows.length;) {
    if (rows[index].kind !== "equal") {
      output.push(rows[index]);
      index += 1;
      continue;
    }
    let end = index;
    while (end < rows.length && rows[end].kind === "equal") end += 1;
    const run = rows.slice(index, end);
    if (run.length <= context * 2 + 1) output.push(...run);
    else {
      output.push(...run.slice(0, context));
      output.push({ kind: "skip", count: run.length - context * 2 });
      output.push(...run.slice(-context));
    }
    index = end;
  }
  return output;
}

function buildSideBySideDiff(beforeText, afterText, options = {}) {
  const context = options.context ?? 2;
  const beforeLines = beforeText ? beforeText.replaceAll("\r\n", "\n").split("\n") : [];
  const afterLines = afterText ? afterText.replaceAll("\r\n", "\n").split("\n") : [];
  const operations = lcsOperations(beforeLines, afterLines);
  const numbered = [];
  let beforeNumber = 1;
  let afterNumber = 1;
  let index = 0;

  while (index < operations.length) {
    const operation = operations[index];
    if (operation.kind === "equal") {
      const segments = [{ kind: "equal", text: operation.before }];
      numbered.push({
        kind: "equal",
        before: line(operation.before, beforeNumber, segments),
        after: line(operation.after, afterNumber, segments),
      });
      beforeNumber += 1;
      afterNumber += 1;
      index += 1;
      continue;
    }

    const deleted = [];
    const inserted = [];
    while (index < operations.length && operations[index].kind !== "equal") {
      if (operations[index].kind === "delete") {
        deleted.push({ text: operations[index].before, number: beforeNumber });
        beforeNumber += 1;
      } else {
        inserted.push({ text: operations[index].after, number: afterNumber });
        afterNumber += 1;
      }
      index += 1;
    }

    const blockLength = Math.max(deleted.length, inserted.length);
    for (let blockIndex = 0; blockIndex < blockLength; blockIndex += 1) {
      const removed = deleted[blockIndex];
      const added = inserted[blockIndex];
      if (removed && added) {
        const tokens = diffLineTokens(removed.text, added.text);
        numbered.push({
          kind: "replace",
          before: line(removed.text, removed.number, tokens.before),
          after: line(added.text, added.number, tokens.after),
        });
      } else if (removed) {
        numbered.push({
          kind: "delete",
          before: line(removed.text, removed.number, [{ kind: "delete", text: removed.text }]),
          after: null,
        });
      } else {
        numbered.push({
          kind: "insert",
          before: null,
          after: line(added.text, added.number, [{ kind: "insert", text: added.text }]),
        });
      }
    }
  }

  const stats = numbered.reduce((counts, row) => {
    if (row.kind === "delete" || row.kind === "replace") counts.removed += 1;
    if (row.kind === "insert" || row.kind === "replace") counts.added += 1;
    if (row.kind === "replace") counts.modified += 1;
    return counts;
  }, { added: 0, removed: 0, modified: 0 });

  return { rows: collapseContext(numbered, context), stats };
}

globalThis.IntentTextDiff = Object.freeze({ buildSideBySideDiff, diffLineTokens });
