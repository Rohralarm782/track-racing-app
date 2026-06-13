import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import eventsRouter from './routes/events';
import categoriesRouter from './routes/categories';
import teamsRouter from './routes/teams';
import { requireAdmin } from './middleware/auth';

dotenv.config();

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors({
  origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

// Health check (Railway uses this)
app.get('/health', (_req, res) => res.json({ ok: true }));

// Admin token verify (lets frontend check the password immediately after login)
app.get('/api/admin/verify', requireAdmin, (_req, res) => res.json({ ok: true }));

// Routes
app.use('/api/events', eventsRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/teams', teamsRouter);

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Interner Serverfehler' });
});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
