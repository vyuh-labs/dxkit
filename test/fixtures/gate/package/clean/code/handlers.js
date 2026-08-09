function orderTotal(items) {
  return items.reduce((sum, i) => sum + i.price, 0);
}
module.exports = { orderTotal };
