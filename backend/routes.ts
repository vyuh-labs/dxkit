import { Router } from 'express';
const app = Router();
app.get('/articles', (req, res) => res.json([]));
app.get('/articles/:slug', (req, res) => res.json({}));
app.post('/articles', (req, res) => res.json({}));
export default app;
