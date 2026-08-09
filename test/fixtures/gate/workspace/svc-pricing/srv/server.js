const express = require('express');
const app = express();
app.get('/price', (_req, res) => res.json({ amount: 10 }));
app.get('/legacy-rebate', (_req, res) => res.json({})); // seeded DEAD ROUTE
module.exports = app;
