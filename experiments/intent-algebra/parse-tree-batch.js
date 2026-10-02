#!/usr/bin/env node

import { createInterface } from "node:readline";
import { parseToTree } from "../../server/ingest/parseTree.js";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdout.write(`${JSON.stringify({ ready: true, protocol: 1 })}\n`);

for await (const line of lines) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
    const [before_tree, after_tree] = await Promise.all([
      parseToTree(request.before_source || "", request.language),
      parseToTree(request.after_source || "", request.language),
    ]);
    process.stdout.write(`${JSON.stringify({
      id: request.id,
      ok: Boolean(before_tree && after_tree),
      before_tree,
      after_tree,
    })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      id: request?.id || "",
      ok: false,
      error: `${error.name}: ${error.message}`,
    })}\n`);
  }
}
