const express = require('express');
const app = express();
app.get('/invoice', async (_req, res) => {
  const tax = await fetch('http://pricing.internal/tax?amount=10').then((r) => r.json()); // seeded UNRESOLVED
  res.json({ total: 10 + tax.value });
});
module.exports = app;
