import { paidTotal } from './billing.js';
export function buildReport(orders) {
  return { revenue: paidTotal(orders) };
}
