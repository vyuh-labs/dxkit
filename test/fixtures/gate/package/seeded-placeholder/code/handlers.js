function orderTotal(items) {
  // TODO wire discount handling
  return items.reduce((sum, i) => sum + i.price, 0);
}
module.exports = { orderTotal };
