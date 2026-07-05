import { Router } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';
import { parseCommuniqueNumber } from '../lib/classify';

const router = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Matching-Heuristik ─────────────────────────────────────────────────────
// Drei unabhängige Signale werden zu einem Score addiert. Bei Mehrdeutigkeit
// (zwei gleich gute Treffer) wird lieber gar nicht verknüpft als geraten.
//   1. Disziplin-Kürzel passt zum Klartext im Zeitplan               (+1)
//   2. Phase überschneidet sich als Teilstring                       (+2)
//   3. Rang-Übereinstimmung: innerhalb derselben AK+Disziplin steht
//      die Kommuniqué-Nummer in derselben Reihenfolge wie der         (+3)
//      Zeitplan-Eintrag — robust gegen neue/unbekannte Schreib-
//      varianten der Phase, da rein numerisch und textunabhängig.

const DISCIPLINE_HINTS: Record<string, string[]> = {
  MA: ['madison'],
  PR: ['punktefahren'],
  OM: ['omnium'],
  TR: ['temporunden'],
  VF: ['verfolgung'],
  MV: ['mannschaftsverfolgung'],
  EV: ['einzelverfolgung', ' ev', 'ev '],
};

// Phasen-Kürzel aus Kommuniqué-Dateinamen auf die von der KI aus dem
// Zeitplan-PDF extrahierten Klartext-Bezeichnungen mappen. Muss VOR dem
// Entfernen der Satzzeichen laufen, da z.B. "1.VL" sonst zu "1vl" ohne
// Wortgrenze verschmilzt und die Regex nicht mehr greift.
const PHASE_ALIASES: Array<[RegExp, string]> = [
  [/\bvl\b/gi, 'vorlauf'],
  [/\bvf\b/gi, 'viertelfinale'],
  [/\bhf\b/gi, 'halbfinale'],
  [/\bquali\b/gi, 'qualifikation'],
];

function normalize(s: string): string {
  let n = s;
  for (const [re, full] of PHASE_ALIASES) n = n.replace(re, full);
  return n.toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Ermittelt, welchem Disziplin-Kürzel ein Zeitplan-Eintrag (nur als Klartext
// vorhanden) entspricht — für das Rang-Matching, da Einträge selbst kein
// Kürzel haben. Bei Mehrdeutigkeit (mehrere Kürzel passen zufällig) wird
// null zurückgegeben, um keine falsche Gruppierung zu riskieren.
function inferCodeForEntry(disciplineLabel: string): string | null {
  const norm = normalize(disciplineLabel);
  const matches = Object.entries(DISCIPLINE_HINTS).filter(([, hints]) => hints.some(h => norm.includes(h)));
  return matches.length === 1 ? matches[0][0] : null;
}

interface MatchableEntry {
  id: string;
  ak: string;
  disciplineLabel: string;
  phase: string | null;
  order: number;
}
interface MatchableDoc {
  id: string;
  ak: string;
  disciplineCode: string | null;
  phaseLabel: string | null;
  docType: string;
  fileName: string;
}

// Rang (0, 1, 2, …) jedes RACE-Eintrags innerhalb aller Einträge derselben
// Altersklasse+Disziplin, sortiert nach zeitlicher Reihenfolge (order).
function rankEntries(entries: MatchableEntry[]): Map<string, number> {
  const groups = new Map<string, MatchableEntry[]>();
  for (const e of entries) {
    const code = inferCodeForEntry(e.disciplineLabel);
    if (!code) continue;
    const key = `${e.ak}::${code}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  const rank = new Map<string, number>();
  for (const group of groups.values()) {
    group.sort((a, b) => a.order - b.order);
    group.forEach((e, i) => rank.set(e.id, i));
  }
  return rank;
}

// Rang jedes STARTLISTE-Dokuments innerhalb derselben Altersklasse+Disziplin,
// sortiert nach Kommuniqué-Nummer (K-Nummer folgt der Ablaufreihenfolge).
function rankDocs(docs: MatchableDoc[]): Map<string, number> {
  const groups = new Map<string, MatchableDoc[]>();
  for (const d of docs) {
    if (d.docType !== 'STARTLISTE' || !d.disciplineCode) continue;
    const key = `${d.ak}::${d.disciplineCode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(d);
  }
  const rank = new Map<string, number>();
  for (const group of groups.values()) {
    group.sort((a, b) => parseCommuniqueNumber(a.fileName) - parseCommuniqueNumber(b.fileName));
    group.forEach((d, i) => rank.set(d.id, i));
  }
  return rank;
}

function findBestMatch(
  entry: MatchableEntry,
  docs: MatchableDoc[],
  entryRank: number | undefined,
  docRank: Map<string, number>,
): MatchableDoc | null {
  const candidates = docs.filter(d => d.docType === 'STARTLISTE' && d.ak === entry.ak);
  if (candidates.length === 0) return null;

  const disciplineNorm = normalize(entry.disciplineLabel);
  const phaseNorm = entry.phase ? normalize(entry.phase) : null;
  const entryCode = inferCodeForEntry(entry.disciplineLabel);

  const scored = candidates
    .map(d => {
      let score = 0;
      if (d.disciplineCode) {
        const hints = DISCIPLINE_HINTS[d.disciplineCode] ?? [];
        if (hints.some(h => disciplineNorm.includes(h))) score += 1;
      }
      if (phaseNorm && d.phaseLabel) {
        const dPhaseNorm = normalize(d.phaseLabel);
        if (dPhaseNorm.includes(phaseNorm) || phaseNorm.includes(dPhaseNorm)) score += 2;
      }
      if (entryRank !== undefined && d.disciplineCode === entryCode && docRank.get(d.id) === entryRank) {
        score += 3;
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

  const [allRaceEntries, docs] = await Promise.all([
    prisma.scheduleEntry.findMany({ where: { eventId, type: 'RACE' } }),
    prisma.communiqueDocument.findMany({ where: { sourceId: source.id } }),
  ]);

  const alreadyLinked = new Set(
    allRaceEntries.filter(e => e.linkedDocumentId).map(e => e.linkedDocumentId!)
  );
  const openEntries = allRaceEntries.filter(e => !e.linkedDocumentId);

  // Ränge werden über ALLE Einträge/Dokumente berechnet (nicht nur die noch
  // offenen), damit die Reihenfolge stabil bleibt, unabhängig davon, was
  // bereits manuell oder in einem früheren Lauf verknüpft wurde.
  const entryRank = rankEntries(allRaceEntries);
  const docRank = rankDocs(docs);

  for (const entry of openEntries) {
    const available = docs.filter(d => !alreadyLinked.has(d.id));
    const match = findBestMatch(entry, available, entryRank.get(entry.id), docRank);
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
