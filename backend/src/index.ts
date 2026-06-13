import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import eventsRouter from './routes/events';
import categoriesRouter from './routes/categories';
import teamsRouter from './routes/teams';
import racesRouter from './routes/races';
import { sprintsRouter, lapsRouter } from './routes/resources';
import { requireAdmin } from './middleware/auth';

dotenv.config();

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors({
  origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/admin/verify', requireAdmin, (_req, res) => res.json({ ok: true }));

app.use('/api/events',     eventsRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/teams',      teamsRouter);
app.use('/api/races',      racesRouter);
app.use('/api/sprints',    sprintsRouter);
app.use('/api/laps',       lapsRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Interner Serverfehler' });
});

app.listen(PORT, () => console.log(`Server laeuft auf Port ${PORT}`));
