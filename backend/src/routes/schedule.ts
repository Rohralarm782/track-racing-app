import { Router } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';

const router = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Matching-Heuristik ─────────────────────────────────────────────────────
// Bewusst simpel und deterministisch (kein KI-Call): gleiche Altersklasse,
// Disziplin-Kürzel passt zum Klartext im Zeitplan, und — falls vorhanden —
// die Phase überschneidet sich als Teilstring. Bei Mehrdeutigkeit (zwei
// gleich gute Treffer) wird lieber gar nicht verknüpft als geraten.

const DISCIPLINE_HINTS: Record<string, string[]> = {
  MA: ['madison'],
  PR: ['punktefahren'],
  OM: ['omnium'],
  TR: ['temporunden'],
  VF: ['verfolgung'],
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

interface MatchableEntry {
  id: string;
  ak: string;
  disciplineLabel: string;
  phase: string | null;
}
interface MatchableDoc {
  id: string;
  ak: string;
  disciplineCode: string | null;
  phaseLabel: string | null;
  docType: string;
}

function findBestMatch(entry: MatchableEntry, docs: MatchableDoc[]): MatchableDoc | null {
  const candidates = docs.filter(d => d.docType === 'STARTLISTE' && d.ak === entry.ak);
  if (candidates.length === 0) return null;

  const disciplineNorm = normalize(entry.disciplineLabel);
  const phaseNorm = entry.phase ? normalize(entry.phase) : null;

  const scored = candidates
    .map(d => {
      let score = 0;
      if (d.disciplineCode) {
        const hints = DISCIPLINE_HINTS[d.disciplineCode] ?? [];
        if (hints.some(h => disciplineNorm.includes(h))) score += 2;
      }
      if (phaseNorm && d.phaseLabel) {
        const dPhaseNorm = normalize(d.phaseLabel);
        if (dPhaseNorm.includes(phaseNorm) || phaseNorm.includes(dPhaseNorm)) score += 3;
      }
      return { doc: d, score };
    })
    .filter(s => s.score > 0);

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  if (scored.length > 1 && scored[1].score === scored[0].score) return null; // uneindeutig — lieber nicht raten
  return scored[0].doc;
}

async function autoMatch(eventId: string) {
  const source = await prisma.communiqueSource.findUnique({ where: { eventId } });
  if (!source) return;

  const [openEntries, docs, linkedRows] = await Promise.all([
    prisma.scheduleEntry.findMany({ where: { eventId, type: 'RACE', linkedDocumentId: null } }),
    prisma.communiqueDocument.findMany({ where: { sourceId: source.id } }),
    prisma.scheduleEntry.findMany({ where: { eventId, linkedDocumentId: { not: null } }, select: { linkedDocumentId: true } }),
  ]);

  const alreadyLinked = new Set(linkedRows.map(r => r.linkedDocumentId!));

  for (const entry of openEntries) {
    const available = docs.filter(d => !alreadyLinked.has(d.id));
    const match = findBestMatch(entry, available);
    if (match) {
      await prisma.scheduleEntry.update({ where: { id: entry.id }, data: { linkedDocumentId: match.id } });
      alreadyLinked.add(match.id);
    }
  }
}

function loadScheduleWithLinks(eventId: string) {
  return prisma.scheduleEntry.findMany({
    where: { eventId },
    orderBy: { order: 'asc' },
    include: { linkedDocument: { select: { id: true, fileName: true, mevNames: true, mevAnalyzedAt: true } } },
  });
}

// ─── Zeitplan-Import ────────────────────────────────────────────────────────

// POST /api/events/:id/schedule/analyze — Zeitplan-PDF analysieren, noch nicht speichern
router.post('/events/:id/schedule/analyze', requireAdmin, async (req, res, next) => {
  try {
    const { pdfBase64 } = req.body;
    if (!pdfBase64) { res.status(400).json({ error: 'pdfBase64 fehlt' }); return; }

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } } as any,
          {
            type: 'text',
            text: `Analysiere diesen Zeitplan einer Bahnrad-Veranstaltung (kann mehrere Tage umfassen).
Gib NUR JSON zurück (kein Markdown, kein Text davor/danach):

{"entries":[{"day":1,"time":"17:00","ak":"U17m","disciplineLabel":"Punktefahren","phase":"Vorläufe","type":"RACE","massStart":true}]}

Regeln:
- day: 1 = erster im Dokument vorkommender Veranstaltungstag, 2 = zweiter usw. (Reihenfolge im Dokument, nicht das Kalenderdatum selbst — manche Zeitplan-Dokumente haben fehlerhafte/inkonsistente Jahresangaben, das ist irrelevant, nur die Reihenfolge und Uhrzeit zählen)
- time: Uhrzeit im Format "HH:MM", so wie im Dokument angegeben
- ak: Altersklasse normalisiert (z.B. "U17m", "U15w", "Elite m"); falls ein Eintrag mehrere AKs gleichzeitig betrifft, "Mehrere" verwenden
- disciplineLabel: Disziplin als Klartext (z.B. "Punktefahren", "Madison", "Omnium Scratch", "3000m Mannschaftsverfolgung")
- phase: Phasen-Bezeichnung falls vorhanden (z.B. "1. Vorlauf", "Finale", "A-Lauf", "Qualifikation"), sonst weglassen
- type: "RACE" für Wettkämpfe, "CEREMONY" für Siegerehrungen, "INFO" für Warm-Up/Pausen/Ende-Hinweise
- massStart: true bei Massenstart-Formaten (Punktefahren, Madison, Scratch, Ausscheidungsfahren, Temporunden), false bei Einzelstart-Formaten (Zeitfahren, Verfolgung, Sprint)
- Reihenfolge der Einträge im JSON muss der zeitlichen Reihenfolge im Dokument entsprechen
- Nur JSON, sonst nichts`,
          },
        ],
      }],
    });

    const text = (message.content.find((c: any) => c.type === 'text') as any)?.text ?? '{}';
    const clean = text.replace(/```json\n?|```/g, '').trim();
    const parsed = JSON.parse(clean);
    res.json(parsed);
  } catch (e) { next(e); }
});

const EntrySchema = z.object({
  day: z.number().int().min(1),
  time: z.string(),
  ak: z.string(),
  disciplineLabel: z.string(),
  phase: z.string().nullable().optional(),
  type: z.enum(['RACE', 'CEREMONY', 'INFO']).default('RACE'),
  massStart: z.boolean().default(false),
});

// POST /api/events/:id/schedule — bestätigte Liste speichern (ersetzt bestehende Einträge komplett)
router.post('/events/:id/schedule', requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.object({ entries: z.array(EntrySchema) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const eventId = req.params.id;

    await prisma.$transaction(async (tx) => {
      await tx.scheduleEntry.deleteMany({ where: { eventId } });
      await tx.scheduleEntry.createMany({
        data: parsed.data.entries.map((e, i) => ({
          eventId,
          day: e.day,
          time: e.time,
          ak: e.ak,
          disciplineLabel: e.disciplineLabel,
          phase: e.phase ?? null,
          type: e.type,
          massStart: e.massStart,
          order: i,
        })),
      });
    });

    await autoMatch(eventId);
    res.status(201).json(await loadScheduleWithLinks(eventId));
  } catch (e) { next(e); }
});

// GET /api/events/:id/schedule — Liste inkl. verknüpftem Kommuniqué
router.get('/events/:id/schedule', async (req, res, next) => {
  try {
    res.json(await loadScheduleWithLinks(req.params.id));
  } catch (e) { next(e); }
});

// POST /api/events/:id/schedule/rematch — Matching manuell erneut anstoßen
// (z.B. nachdem neue Kommuniqués eingetroffen sind)
router.post('/events/:id/schedule/rematch', requireAdmin, async (req, res, next) => {
  try {
    await autoMatch(req.params.id);
    res.json(await loadScheduleWithLinks(req.params.id));
  } catch (e) { next(e); }
});

// PATCH /api/schedule-entries/:id — manuelle Korrektur (z.B. Kommuniqué per Hand verknüpfen/lösen)
const PatchEntrySchema = z.object({
  linkedDocumentId: z.string().nullable().optional(),
});

router.patch('/schedule-entries/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = PatchEntrySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    if (parsed.data.linkedDocumentId === undefined) { res.json(await prisma.scheduleEntry.findUnique({ where: { id: req.params.id } })); return; }
    const entry = await prisma.scheduleEntry.update({
      where: { id: req.params.id },
      data: { linkedDocumentId: parsed.data.linkedDocumentId },
    });
    res.json(entry);
  } catch (e) { next(e); }
});

// ─── Aktueller Stand ────────────────────────────────────────────────────────

router.get('/events/:id/status', async (req, res, next) => {
  try {
    const status = await prisma.eventStatus.findUnique({
      where: { eventId: req.params.id },
      include: { scheduleEntry: true },
    });
    res.json(status);
  } catch (e) { next(e); }
});

const StatusSchema = z.object({
  scheduleEntryId: z.string(),
  statusKey: z.enum(['STARTING', 'RUNNING', 'FINISHED']),
  roundsLeft: z.number().int().min(0).nullable().optional(),
});

router.put('/events/:id/status', requireAdmin, async (req, res, next) => {
  try {
    const parsed = StatusSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const { scheduleEntryId, statusKey, roundsLeft } = parsed.data;

    const entry = await prisma.scheduleEntry.findUnique({ where: { id: scheduleEntryId } });
    if (!entry || entry.eventId !== req.params.id) {
      res.status(404).json({ error: 'Zeitplan-Eintrag nicht gefunden' });
      return;
    }

    const [h, m] = entry.time.split(':').map(Number);
    const plannedMin = h * 60 + m;
    const now = new Date();
    const offsetMinutes = (now.getHours() * 60 + now.getMinutes()) - plannedMin;

    const status = await prisma.eventStatus.upsert({
      where: { eventId: req.params.id },
      create: {
        eventId: req.params.id, scheduleEntryId, statusKey,
        roundsLeft: roundsLeft ?? null, offsetMinutes,
      },
      update: { scheduleEntryId, statusKey, roundsLeft: roundsLeft ?? null, offsetMinutes },
      include: { scheduleEntry: true },
    });
    res.json(status);
  } catch (e) { next(e); }
});

export default router;
