import { currentSpan, traced } from 'braintrust';

export const contentTraceEnabled = () => process.env.ENABLE_CONTENT_TRACING === 'true' && !process.env.PORT;

// Record observable application steps, without changing their inputs or outputs.
export async function traceStep(name, input, fn) {
  if (!contentTraceEnabled()) return fn();
  return traced(async (span) => {
    span.log({ input });
    const output = await fn();
    if (output !== undefined) span.log({ output });
    return output;
  }, { name, type: 'function' });
}

export function traceEvent(name, input, output) {
  if (!contentTraceEnabled()) return;
  const span = currentSpan().startSpan({ name, type: 'function' });
  try { span.log({ input, output }); } finally { span.end(); }
}
