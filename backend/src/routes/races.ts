import { Router } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';
import { computePunktefahren, computeTemporennen } from '../lib/scoring';

const router = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Status-Hilfsfunktion – nur upgraden, nie downgraden (SETUP→ACTIVE→FINISHED)
async function advanceStatus(raceId: string, target: 'ACTIVE' | 'FINISHED') {
  const race = await prisma.race.findUnique({ where: { id: raceId }, select: { status: true } });
  if (!race) return;
  if (target === 'ACTIVE'   && race.status === 'SETUP')   await prisma.race.update({ where: { id: raceId }, data: { status: 'ACTIVE' } });
  if (target === 'FINISHED' && race.status !== 'FINISHED') await prisma.race.update({ where: { id: raceId }, data: { status: 'FINISHED' } });
}


router.get('/:id', async (req, res, next) => {
  try {
    const race = await prisma.race.findUnique({
      where: { id: req.params.id },
      include: {
        category: {
          include: {
            teams: { orderBy: { number: 'asc' } },
            event: { select: { id: true, name: true } },
          },
        },
        event: { select: { id: true, name: true } },
        teams: { orderBy: { number: 'asc' } },
        sprints: {
          orderBy: { number: 'asc' },
          include: { results: { orderBy: { position: 'asc' }, include: { team: true } } },
        },
        lapEvents: { orderBy: { createdAt: 'asc' }, include: { team: true } },
        omniumScores: { include: { team: true } },
        flags: { include: { team: true } },
      },
    });
    if (!race) { res.status(404).json({ error: 'Nicht gefunden' }); return; }

    const isLegacy = race.categoryId !== null;

    let activeTeams;
    let dnsTeams: typeof race.teams = [];
    let categoryPayload: any;

    if (isLegacy) {
      // Alt: Teams gehören der Kategorie, DNS-Flag blendet einzelne Teams für
      // dieses eine Rennen aus (bleiben Teil der Kategorie für andere Rennen).
      const dnsIds = new Set(race.flags.filter(f => f.type === 'DNS').map(f => f.teamId));
      activeTeams = race.category!.teams.filter(t => !dnsIds.has(t.id));
      dnsTeams = race.category!.teams.filter(t => dnsIds.has(t.id));
      categoryPayload = { ...race.category, teams: activeTeams };
    } else {
      // Neu: Teams gehören direkt zum Rennen — keine Kategorie, kein DNS nötig,
      // die Ansetzung *ist* schon die Startliste.
      activeTeams = race.teams;
      categoryPayload = {
        id: null, name: race.ak ?? race.name, format: race.format ?? 'INDIVIDUAL',
        teams: activeTeams, event: race.event,
      };
    }

    const scoreboard = race.type === 'PUNKTEFAHREN'
      ? computePunktefahren(activeTeams, race.sprints, race.lapEvents, race.omniumScores, race.flags)
      : race.type === 'TEMPORUNDEN'
      ? computeTemporennen(activeTeams, race.sprints, race.lapEvents, race.flags)
      : null;

    res.json({
      ...race,
      category: categoryPayload,
      dnsTeams,
      scoreboard,
    });
  } catch (e) { next(e); }
});

const CreateRaceSchema = z.object({
  categoryId: z.string().optional(),
  eventId: z.string().optional(),
  ak: z.string().optional(),
  type: z.enum(['PUNKTEFAHREN', 'TEMPORUNDEN', 'VERFOLGUNGSRENNEN']),
  format: z.enum(['INDIVIDUAL', 'TEAM_PAIRS']).optional(),
  name: z.string().min(1),
  order: z.number().int().default(0),
}).refine(d => !!d.categoryId || !!d.eventId, {
  message: 'categoryId oder eventId muss angegeben sein',
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = CreateRaceSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const race = await prisma.race.create({ data: parsed.data });
    res.status(201).json(race);
  } catch (e) { next(e); }
});

router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { status, finaleActive, name } = req.body;
    const data: Record<string, unknown> = {};
    if (status !== undefined) data.status = status;
    if (finaleActive !== undefined) data.finaleActive = finaleActive;
    if (name !== undefined) data.name = name;
    const race = await prisma.race.update({ where: { id: req.params.id }, data: data as any });
    res.json(race);
  } catch (e) { next(e); }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.race.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (e) { next(e); }
});

// POST /api/races/:id/omnium
// strategy: 'import'  → importierte Punkte übernehmen (Standard)
//           'keep'    → vorhandene Punkte behalten, nur neue ergänzen
//           'higher'  → jeweils die höhere Punktzahl behalten
const OmniumBatchSchema = z.object({
  scores: z.array(z.object({ teamId: z.string(), points: z.number().int() })),
  strategy: z.enum(['import', 'keep', 'higher']).default('import'),
});

router.post('/:id/omnium', requireAdmin, async (req, res, next) => {
  try {
    const parsed = OmniumBatchSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const { scores, strategy } = parsed.data;
    const raceId = req.params.id;

    if (strategy === 'higher') {
      // Erst vorhandene Punkte laden, dann jeweils das Maximum speichern
      const existing = await prisma.omniumScore.findMany({ where: { raceId } });
      const existingMap = new Map(existing.map(e => [e.teamId, e.points]));

      await prisma.$transaction(
        scores.map(s => {
          const pts = Math.max(existingMap.get(s.teamId) ?? 0, s.points);
          return prisma.omniumScore.upsert({
            where: { raceId_teamId: { raceId, teamId: s.teamId } },
            create: { raceId, teamId: s.teamId, points: pts },
            update: { points: pts },
          });
        })
      );
    } else {
      // 'import': vorhandene überschreiben | 'keep': nur neue eintragen (update leer lassen)
      await prisma.$transaction(
        scores.map(s =>
          prisma.omniumScore.upsert({
            where: { raceId_teamId: { raceId, teamId: s.teamId } },
            create: { raceId, teamId: s.teamId, points: s.points },
            update: strategy === 'import' ? { points: s.points } : {},
          })
        )
      );
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/races/:id/omnium-pdf — bestehender Endpunkt unverändert
router.post('/:id/omnium-pdf', requireAdmin, async (req, res, next) => {
  try {
    const { pdfBase64 } = req.body;
    if (!pdfBase64) { res.status(400).json({ error: 'pdfBase64 fehlt' }); return; }

    const race = await prisma.race.findUnique({
      where: { id: req.params.id },
      include: { category: { include: { teams: true } }, teams: true },
    });
    if (!race) { res.status(404).json({ error: 'Nicht gefunden' }); return; }

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } } as any,
          {
            type: 'text',
            text: `Dies ist eine Omnium-Zwischenwertung oder Ergebnisliste.
Extrahiere Startnummern und Gesamtpunkte. Gib NUR JSON zurück:
{"scores":[{"number":173,"points":106}]}
- number: Startnummer/BIB als Ganzzahl
- points: Gesamtpunktzahl (letzte Zahlenspalte / "Gesamt")
- Nur JSON, sonst nichts`,
          },
        ],
      }],
    });

    const text = (message.content.find((c: any) => c.type === 'text') as any)?.text ?? '';
    const clean = text.replace(/```json\n?|```/g, '').trim();
    const { scores } = JSON.parse(clean);

    const relevantTeams = race.category ? race.category.teams : race.teams;
    const teamMap = new Map(relevantTeams.map(t => [t.number, t.id]));
    const raceId = req.params.id;
    const matched = scores.filter((s: any) => teamMap.has(s.number));

    await prisma.$transaction(
      matched.map((s: any) =>
        prisma.omniumScore.upsert({
          where: { raceId_teamId: { raceId, teamId: teamMap.get(s.number)! } },
          create: { raceId, teamId: teamMap.get(s.number)!, points: s.points },
          update: { points: s.points },
        })
      )
    );

    res.json({ imported: matched.length, total: scores.length });
  } catch (e) { next(e); }
});

// POST /api/races/:id/tempo-round — eine Temporunden-Runde eintragen
// results = [] → Runde übersprungen (kein Sieger erfasst)
// results = [{ teamId, position: 1 }] → Rundensieger
// number = explizite Rundennummer (für Nachtragen / Überschreiben)
const TempoRoundSchema = z.object({
  number: z.number().int().min(1),
  results: z.array(z.object({ teamId: z.string(), position: z.number().int().min(1) })),
});

router.post('/:id/tempo-round', requireAdmin, async (req, res, next) => {
  try {
    const parsed = TempoRoundSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const { number, results } = parsed.data;
    const raceId = req.params.id;

    const sprint = await prisma.$transaction(async (tx) => {
      // Vorhandenen Sprint mit gleicher Nummer ersetzen (Nachtragen / Korrigieren)
      const existing = await tx.sprint.findUnique({ where: { raceId_number: { raceId, number } } });
      if (existing) {
        await tx.sprintResult.deleteMany({ where: { sprintId: existing.id } });
        await tx.sprint.delete({ where: { id: existing.id } });
      }

      const s = await tx.sprint.create({ data: { raceId, number, isFinale: false } });
      if (results.length > 0) {
        await tx.sprintResult.createMany({
          data: results.map(r => ({ sprintId: s.id, teamId: r.teamId, position: r.position })),
        });
      }
      return tx.sprint.findUnique({
        where: { id: s.id },
        include: { results: { include: { team: true }, orderBy: { position: 'asc' } } },
      });
    });
    // Ersten Eintrag → ACTIVE
    if (results.length > 0) await advanceStatus(raceId, 'ACTIVE');
    res.status(201).json(sprint);
  } catch (e) { next(e); }
});

// POST /api/races/:id/sprints
const CreateSprintSchema = z.object({
  isFinale: z.boolean().default(false),
  results: z.array(z.object({ teamId: z.string(), position: z.number().int().min(1) })).min(1),
});

router.post('/:id/sprints', requireAdmin, async (req, res, next) => {
  try {
    const parsed = CreateSprintSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const raceId = req.params.id;
    const lastSprint = await prisma.sprint.findFirst({ where: { raceId }, orderBy: { number: 'desc' } });
    const number = (lastSprint?.number ?? 0) + 1;
    const sprint = await prisma.$transaction(async (tx) => {
      const s = await tx.sprint.create({ data: { raceId, number, isFinale: parsed.data.isFinale } });
      await tx.sprintResult.createMany({
        data: parsed.data.results.map(r => ({ sprintId: s.id, teamId: r.teamId, position: r.position })),
      });
      return tx.sprint.findUnique({
        where: { id: s.id },
        include: { results: { include: { team: true }, orderBy: { position: 'asc' } } },
      });
    });
    // Status automatisch setzen
    if (parsed.data.isFinale) {
      await advanceStatus(raceId, 'FINISHED');
    } else {
      await advanceStatus(raceId, 'ACTIVE');
    }
    res.status(201).json(sprint);
  } catch (e) { next(e); }
});

// POST /api/races/:id/laps
const CreateLapSchema = z.object({
  teamId: z.string(),
  delta: z.number().int().refine(v => v === 1 || v === -1),
  note: z.string().optional(),
});

router.post('/:id/laps', requireAdmin, async (req, res, next) => {
  try {
    const parsed = CreateLapSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const lap = await prisma.lapEvent.create({
      data: { raceId: req.params.id, ...parsed.data },
      include: { team: true },
    });
    await advanceStatus(req.params.id, 'ACTIVE');
    res.status(201).json(lap);
  } catch (e) { next(e); }
});

// POST /api/races/:id/flags
router.post('/:id/flags', requireAdmin, async (req, res, next) => {
  try {
    const { teamId, type } = req.body;
    if (!['DSQ', 'WARNING', 'DNS'].includes(type)) { res.status(400).json({ error: 'Ungültiger Typ' }); return; }
    await prisma.raceFlag.upsert({
      where: { raceId_teamId_type: { raceId: req.params.id, teamId, type } },
      create: { raceId: req.params.id, teamId, type },
      update: {},
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/races/:id/apply-ansetzung — setzt anhand einer per KI erkannten
// Renn-Ansetzung (Communiqué), wer in DIESEM Rennen startet.
// - Altes Modell (Rennen hat Kategorie): Teams der Kategorie, die nicht in
//   der Liste stehen, bekommen ein DNS-Flag für dieses Rennen (bleiben Teil
//   der Kategorie für andere Rennen). Bereits gesetzte DNS-Flags von Teams,
//   die jetzt wieder in der Liste stehen, werden entfernt.
// - Neues Modell (Rennen ohne Kategorie): Die Ansetzung *ist* die Startliste —
//   Teams werden direkt am Rennen angelegt (upsert per Startnummer), MEV
//   automatisch als Favorit markiert. Kein DNS nötig.
router.post('/:id/apply-ansetzung', requireAdmin, async (req, res, next) => {
  try {
    const { teams } = req.body as {
      teams: Array<{
        number: number; name: string; club?: string | null; lv?: string | null;
        rider2?: string | null; rider2Club?: string | null; rider2Lv?: string | null;
      }>;
    };
    if (!Array.isArray(teams)) { res.status(400).json({ error: 'teams fehlt' }); return; }

    const race = await prisma.race.findUnique({
      where: { id: req.params.id },
      include: { category: { include: { teams: true } }, teams: true },
    });
    if (!race) { res.status(404).json({ error: 'Rennen nicht gefunden' }); return; }

    if (race.categoryId) {
      // ── Altes Modell: DNS-Flags gegen die bestehende Kategorie-Startliste ──
      const startingNumbers = new Set(teams.map(t => t.number));
      const toExclude = race.category!.teams.filter(t => !startingNumbers.has(t.number));
      const toInclude = race.category!.teams.filter(t => startingNumbers.has(t.number));

      await prisma.$transaction([
        ...toExclude.map(t => prisma.raceFlag.upsert({
          where: { raceId_teamId_type: { raceId: race.id, teamId: t.id, type: 'DNS' } },
          create: { raceId: race.id, teamId: t.id, type: 'DNS' },
          update: {},
        })),
        ...toInclude.map(t => prisma.raceFlag.deleteMany({
          where: { raceId: race.id, teamId: t.id, type: 'DNS' },
        })),
      ]);

      res.json({
        mode: 'legacy',
        excluded: toExclude.length,
        included: toInclude.length,
        unmatched: teams.length - toInclude.length,
      });
      return;
    }

    // ── Neues Modell: Teams direkt am Rennen anlegen/aktualisieren ──
    const upserted = await prisma.$transaction(
      teams.map(t => {
        const isPair = !!t.rider2;
        const data = {
          name: isPair ? `${t.name} / ${t.rider2}` : t.name,
          club: t.club ?? null,
          rider1: isPair ? t.name : null,
          rider2: t.rider2 ?? null,
          isFavorite: t.lv === 'MEV' || t.rider2Lv === 'MEV',
        };
        return prisma.team.upsert({
          where: { raceId_number: { raceId: race.id, number: t.number } },
          create: { raceId: race.id, number: t.number, ...data },
          update: data,
        });
      })
    );

    // Teams, die vorher am Rennen hingen, aber jetzt nicht mehr in der
    // Ansetzung stehen, entfernen (Korrektur-Ansetzung).
    const keepIds = new Set(upserted.map(t => t.id));
    const toRemove = race.teams.filter(t => !keepIds.has(t.id));
    if (toRemove.length > 0) {
      await prisma.team.deleteMany({ where: { id: { in: toRemove.map(t => t.id) } } });
    }

    res.json({ mode: 'direct', created: upserted.length, removed: toRemove.length });
  } catch (e) { next(e); }
});

export default router;
