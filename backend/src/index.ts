import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import eventsRouter from './routes/events';
import categoriesRouter from './routes/categories';
import teamsRouter from './routes/teams';
import racesRouter from './routes/races';
import { sprintsRouter, lapsRouter, raceFlagsRouter } from './routes/resources';
import { requireAdmin } from './middleware/auth';
import pursuitPlansRouter from './routes/pursuit-plans';  // ← geändert
import communiquesRouter, { pollSource } from './routes/communiques';
import scheduleRouter from './routes/schedule';
import prisma from './prisma';

dotenv.config();
const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors({
  origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '20mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/admin/verify', requireAdmin, (_req, res) => res.json({ ok: true }));

app.use('/api/events',         eventsRouter);
app.use('/api/categories',     categoriesRouter);
app.use('/api/teams',          teamsRouter);
app.use('/api/races',          racesRouter);
app.use('/api/sprints',        sprintsRouter);
app.use('/api/laps',           lapsRouter);
app.use('/api/race-flags',     raceFlagsRouter);
app.use('/api/pursuit-plans',  pursuitPlansRouter);  // ← geändert
app.use('/api/communiques',    communiquesRouter);
app.use('/api',                scheduleRouter); // Zeitplan + Aktueller-Stand-Endpunkte (eigene Pfade unter /api/events/:id/schedule, /api/schedule-entries/:id)

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Interner Serverfehler' });
});

app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));

// ── Kommuniqué-Polling im Hintergrund ────────────────────────────────────────
// Alle 90 Sek. jede hinterlegte Quelle prüfen. Fehler einer Quelle (z.B. Share
// abgelaufen) dürfen die anderen nicht blockieren.
const POLL_INTERVAL_MS = 90_000;

async function pollAllSources() {
  try {
    const sources = await prisma.communiqueSource.findMany();
    for (const source of sources) {
      try {
        await pollSource(source.id, source.shareToken);
      } catch (err) {
        console.error(`Polling fehlgeschlagen für Quelle ${source.id}:`, err);
      }
    }
  } catch (err) {
    console.error('Kommuniqué-Polling-Zyklus fehlgeschlagen:', err);
  }
}

setInterval(pollAllSources, POLL_INTERVAL_MS);
