const express = require('express');
const app = express();
app.get('/orders', async (_req, res) => {
  const price = await fetch('http://pricing.internal/price?order=1').then((r) => r.json());
  res.json({ id: 1, price });
});
module.exports = app;
