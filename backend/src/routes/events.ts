import { Router } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';

const router = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.get('/', async (_req, res, next) => {
  try {
    const events = await prisma.event.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        categories: {
          include: { _count: { select: { teams: true, races: true } } },
          orderBy: { name: 'asc' },
        },
      },
    });
    res.json(events);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({
      where: { id: req.params.id },
      include: {
        categories: {
          include: {
            _count: { select: { teams: true } },
            races: {
              select: { id: true, name: true, type: true, status: true, order: true },
              orderBy: { order: 'asc' },
            },
          },
          orderBy: { name: 'asc' },
        },
        races: {
          // neue, direkte Rennen ohne Kategorie
          include: { _count: { select: { teams: true } } },
          orderBy: { order: 'asc' },
        },
      },
    });
    if (!event) { res.status(404).json({ error: 'Nicht gefunden' }); return; }
    res.json(event);
  } catch (e) { next(e); }
});

const CreateEventSchema = z.object({
  name: z.string().min(1, 'Name ist erforderlich'),
  date: z.string().datetime().optional(),
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = CreateEventSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const event = await prisma.event.create({
      data: {
        name: parsed.data.name,
        date: parsed.data.date ? new Date(parsed.data.date) : null,
      } as any,
    });
    res.status(201).json(event);
  } catch (e) { next(e); }
});

const UpdateEventSchema = CreateEventSchema.partial();

router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = UpdateEventSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const data: Record<string, unknown> = {};
    if (parsed.data.name) data.name = parsed.data.name;
    if (parsed.data.date) data.date = new Date(parsed.data.date);
    const event = await prisma.event.update({ where: { id: req.params.id }, data: data as any });
    res.json(event);
  } catch (e) { next(e); }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.event.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (e) { next(e); }
});

// ── POST /api/events/:id/analyze-startlist ────────────────────────────────────
// Analysiert eine vollständige Meldeliste-PDF und erkennt alle Altersklassen.
// Gibt { ageClasses: [{ name, shortName, teams: [{number, name, club}] }] }
router.post('/:id/analyze-startlist', requireAdmin, async (req, res, next) => {
  try {
    const { pdfBase64 } = req.body;
    if (!pdfBase64) { res.status(400).json({ error: 'pdfBase64 fehlt' }); return; }

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
          } as any,
          {
            type: 'text',
            text: `Analysiere diese vollständige Meldeliste/Startliste/Startaufstellung für eine Bahnradveranstaltung.
Erkenne alle Altersklassen und liste die Teilnehmer je Altersklasse auf.
Gib NUR JSON zurück (kein Markdown, kein Text davor/danach):

{"ageClasses":[{"name":"U17 männlich","shortName":"U17m","teams":[{"number":1,"name":"Vorname Nachname","club":"Vereinsname","lv":"MEV"}]}],"plannedSprints":5}

Regeln:
- Erkenne AK-Abschnitte an Überschriften (z.B. "U17 männlich", "Juniorinnen U19", "Elite Frauen")
- shortName normalisieren: U13m, U13w, U15m, U15w, U17m, U17w, U19m, U19w, Elite m, Elite w, Masters m, Masters w
- number: Startnummer als Ganzzahl
- name: "Vorname Nachname" (NICHT "Nachname, Vorname" — kein Komma!)
- club: Vereinsname aus der Vereinsspalte, null wenn nicht vorhanden
- lv: Landesverband-Kürzel aus der "LV"-Spalte (z.B. "MEV", "BRA", "NRW"), null wenn nicht vorhanden
- points: Falls das Dokument eine Punkte-/Wertungsspalte enthält (z.B. Omnium-Zwischenstand,
  Gesamtpunkte, Punktestand vor einem Rennen), die Gesamtpunktzahl als Ganzzahl angeben.
  Sonst points weglassen (nicht 0 raten, wenn keine Spalte vorhanden ist).
- plannedSprints: Falls im Kopfbereich eine Streckenangabe wie "12,5 km / 50 Runden / 5 Wertungen"
  steht, die Anzahl der Wertungen als Ganzzahl (im Beispiel: 5). Weglassen, wenn nicht vorhanden.

WICHTIG — Team-Paare (z.B. Madison/Zweier-Mannschaftsfahren):
Manche Startlisten haben eine Team-Nummer-Spalte (oft "Nr."), die über GENAU ZWEI Zeilen
zusammengefasst/verschmolzen ist — das bedeutet, diese zwei Fahrer bilden EIN Team.
Erkennst du dieses Muster (z.B. weil der Titel "Madison" oder "Zweier-Mannschaftsfahren"
enthält, oder weil die Nummern-Spalte sichtbar über zwei Zeilen zusammengefasst ist):
- Fasse die zwei Zeilen zu EINEM Team-Eintrag zusammen
- number: die gemeinsame Team-Nummer (aus der zusammengefassten Spalte, NICHT die individuelle Start-Nr.)
- name: Name des ERSTEN Fahrers
- club, lv: Verein/Landesverband des ERSTEN Fahrers
- rider2: Name des ZWEITEN Fahrers ("Vorname Nachname")
- rider2Club: Verein des zweiten Fahrers, null wenn nicht vorhanden
- rider2Lv: Landesverband des zweiten Fahrers, null wenn nicht vorhanden
Bei normalen Einzel-Startlisten (kein Team-Paar-Muster) NIE rider2/rider2Club/rider2Lv angeben.

- Überspringe durchgestrichene Einträge und Kopfzeilen
- Dedupliziere nach Startnummer/Team-Nummer innerhalb einer AK
- Nur reines JSON, sonst nichts`,
          },
        ],
      }],
    });

    const text = (message.content.find((c: any) => c.type === 'text') as any)?.text ?? '';
    const clean = text.replace(/```json\n?|```/g, '').trim();
    res.json(JSON.parse(clean));
  } catch (e) { next(e); }
});

// ── POST /api/events/:id/apply-startlist ─────────────────────────────────────
// Legt Kategorien und Teams anhand der bestätigten Gruppen an.
// Teams mit lv === "MEV" werden automatisch als Favorit markiert. Enthält eine
// Gruppe Team-Paare (rider2 gesetzt, z.B. Madison), wird die Kategorie als
// TEAM_PAIRS angelegt und Name/rider1/rider2 entsprechend gesetzt.
// Body: { groups: [{ name: string, teams: [{number, name, club, lv, rider2, rider2Club, rider2Lv}] }] }
router.post('/:id/apply-startlist', requireAdmin, async (req, res, next) => {
  try {
    const eventId = req.params.id;
    const { groups } = req.body as {
      groups: Array<{
        name: string;
        teams: Array<{
          number: number; name: string; club: string | null; lv?: string | null;
          rider2?: string | null; rider2Club?: string | null; rider2Lv?: string | null;
        }>;
      }>;
    };

    if (!Array.isArray(groups) || groups.length === 0) {
      res.status(400).json({ error: 'groups fehlt oder leer' }); return;
    }

    const created = await prisma.$transaction(async (tx) => {
      const results = [];
      for (const group of groups) {
        const isPairs = group.teams.some(t => !!t.rider2);
        const category = await tx.category.create({
          data: { eventId, name: group.name, format: isPairs ? 'TEAM_PAIRS' : 'INDIVIDUAL' },
        });
        if (group.teams.length > 0) {
          await tx.team.createMany({
            data: group.teams.map(t => ({
              categoryId: category.id,
              number: t.number,
              name: t.rider2 ? `${t.name} / ${t.rider2}` : t.name,
              club: t.club ?? null,
              lv: t.lv ?? null,
              rider2Lv: t.rider2Lv ?? null,
              rider1: t.rider2 ? t.name : null,
              rider2: t.rider2 ?? null,
              isFavorite: t.lv === 'MEV' || t.rider2Lv === 'MEV',
            })),
          });
        }
        results.push({ ...category, teamCount: group.teams.length });
      }
      return results;
    });

    res.status(201).json({ created });
  } catch (e) { next(e); }
});

export default router;
