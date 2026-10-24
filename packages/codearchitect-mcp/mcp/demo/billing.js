// Synthetic example; no customer data.
export function paidTotal(orders) {
  return orders.filter(order => order.status === 'paid')
    .reduce((total, order) => total + order.amount, 0);
}
