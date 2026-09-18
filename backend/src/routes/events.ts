import { Router } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';
import { pairMadisonEntries, type RawEntry } from '../lib/madisonPairing';

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
  location: z.string().optional(),
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = CreateEventSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const event = await prisma.event.create({
      data: {
        name: parsed.data.name,
        date: parsed.data.date ? new Date(parsed.data.date) : null,
        location: parsed.data.location?.trim() || null,
      } as any,
    });
    res.status(201).json(event);
  } catch (e) { next(e); }
});

// Beim Ändern sind date und location bewusst NULLBAR, nicht nur optional:
// nur so lässt sich ein versehentlich gesetztes Datum wieder entfernen.
// "Feld fehlt im Body" (undefined) heißt weiterhin "nicht anfassen" —
// deshalb wird unten auf undefined geprüft und nicht auf Wahrheitswert.
const UpdateEventSchema = z.object({
  name: z.string().min(1, 'Name ist erforderlich').optional(),
  date: z.string().datetime().nullable().optional(),
  location: z.string().nullable().optional(),
  // Bahnlänge in m; null = 250. Grenzen nur gegen Tippfehler.
  trackM: z.number().min(100).max(500).nullable().optional(),
});

router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = UpdateEventSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const data: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name.trim();
    if (parsed.data.date !== undefined) data.date = parsed.data.date ? new Date(parsed.data.date) : null;
    if (parsed.data.location !== undefined) data.location = parsed.data.location?.trim() || null;
    if (parsed.data.trackM !== undefined) data.trackM = parsed.data.trackM;
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

{"ageClasses":[{"name":"U17 männlich","shortName":"U17m","teams":[{"numberRaw":"1","name":"Vorname Nachname","club":"Vereinsname","lv":"MEV"}]}],"plannedSprints":5,"raceKind":"MADISON"}

Regeln:
- Erkenne AK-Abschnitte an Überschriften (z.B. "U17 männlich", "Juniorinnen U19", "Elite Frauen")
- shortName normalisieren: U13m, U13w, U15m, U15w, U17m, U17w, U19m, U19w, Elite m, Elite w, Masters m, Masters w
- numberRaw: der Wert der Nummernspalte als ZEICHENKETTE, GENAU so wie er im
  Dokument steht — also "7" bei einer reinen Zahl, aber "5R" bzw. "5S", wenn
  dort ein Buchstabe angehängt ist. NICHTS abschneiden, nichts umrechnen,
  nicht zu einer Zahl machen. Die Zusammenfassung erledigt das Programm.
- name: "Vorname Nachname" (NICHT "Nachname, Vorname" — kein Komma!)
- club: Vereinsname aus der Vereinsspalte, null wenn nicht vorhanden
- lv: Landesverband-Kürzel aus der "LV"-Spalte (z.B. "MEV", "BRA", "NRW"), null wenn nicht vorhanden
- points: Falls das Dokument eine Punkte-/Wertungsspalte enthält (z.B. Omnium-Zwischenstand,
  Gesamtpunkte, Punktestand vor einem Rennen), die Gesamtpunktzahl als Ganzzahl angeben.
  Sonst points weglassen (nicht 0 raten, wenn keine Spalte vorhanden ist).
- plannedSprints: Falls im Kopfbereich eine Streckenangabe wie "12,5 km / 50 Runden / 5 Wertungen"
  steht, die Anzahl der Wertungen als Ganzzahl (im Beispiel: 5). Weglassen, wenn nicht vorhanden.
- raceKind: Erkenne die Disziplin aus dem Dokumenttitel/Kopfbereich (z.B. "Punktefahren",
  "Madison", "Temporunden"). Werte: "PUNKTEFAHREN", "MADISON" oder "TEMPORUNDEN".
  Weglassen, wenn nicht eindeutig erkennbar.

WICHTIG — Team-Paare (z.B. Madison/Zweier-Mannschaftsfahren):
Es gibt ZWEI Schreibweisen. Bei BEIDEN bilden zwei Fahrer EIN Team.

(a) "Mad.Nr."-Spalte mit R/S-Endung — der häufigere Fall bei Meisterschaften:
    Jeder Fahrer steht in einer EIGENEN Zeile mit einer EIGENEN Nummer, z.B.
    "5R" (rote Rückennummer) und "5S" (schwarze Rückennummer). Die Zellen sind
    NICHT verschmolzen. In diesem Fall:
    - Gib jede Zeile EINZELN aus, mit numberRaw GENAU so wie im Dokument
      ("5R", "5S") — fasse hier NICHTS zusammen und setze KEIN rider2.
    - Die Zusammenfassung zu Teams macht das Programm anhand der R/S-Endung.
    - Ist zusätzlich eine "Startnr."-Spalte vorhanden (individuelle Nummern wie
      69, 70): diese NICHT verwenden. Maßgeblich ist allein die Mad.Nr.

(b) Nummernspalte (oft "Nr."), die über GENAU ZWEI Zeilen zusammengefasst/
    verschmolzen ist. Erkennst du dieses Muster:
    - Fasse die zwei Zeilen zu EINEM Team-Eintrag zusammen
    - numberRaw: die gemeinsame Team-Nummer (aus der zusammengefassten Spalte,
      NICHT die individuelle Start-Nr.)
    - name: Name des ERSTEN Fahrers
    - club, lv: Verein/Landesverband des ERSTEN Fahrers
    - rider2: Name des ZWEITEN Fahrers ("Vorname Nachname")
    - rider2Club: Verein des zweiten Fahrers, null wenn nicht vorhanden
    - rider2Lv: Landesverband des zweiten Fahrers, null wenn nicht vorhanden

Bei normalen Einzel-Startlisten (weder (a) noch (b)) NIE rider2/rider2Club/rider2Lv angeben.

- Überspringe durchgestrichene Einträge und Kopfzeilen
- Dedupliziere nur ECHTE Doppelungen (dieselbe Zeile zweimal) innerhalb einer AK.
  "5R" und "5S" sind KEINE Doppelung, sondern zwei verschiedene Fahrer — beide behalten.
- Nur reines JSON, sonst nichts`,
          },
        ],
      }],
    });

    const text = (message.content.find((c: any) => c.type === 'text') as any)?.text ?? '';
    const clean = text.replace(/```json\n?|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // ── Madison-Paarung: deterministisch, nicht vom Modell ─────────────────
    // Das Modell liefert je Fahrer eine Zeile mit numberRaw ("5R"). Welche
    // Zeilen ein Team bilden, entscheidet der Code — siehe madisonPairing.ts.
    // Fasst das Modell (Fall b) bereits zusammen, trägt keine Zeile eine
    // R/S-Endung und pairMadisonEntries lässt die Liste unverändert.
    const ageClasses = Array.isArray(parsed?.ageClasses) ? parsed.ageClasses : [];
    const warnings: string[] = [];
    const blocking: string[] = [];
    for (const ak of ageClasses) {
      const raw: RawEntry[] = Array.isArray(ak?.teams) ? ak.teams : [];
      const paired = pairMadisonEntries(raw);
      ak.teams = paired.teams;
      const tag = ak?.shortName ?? ak?.name ?? 'AK';
      for (const w of paired.warnings) warnings.push(`${tag}: ${w}`);
      for (const b of paired.blocking) blocking.push(`${tag}: ${b}`);
    }

    res.json({ ...parsed, ageClasses, warnings, blocking });
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
          rider1Bib?: string | null; rider2Bib?: string | null;
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
              rider1Bib: t.rider1Bib ?? null,
              rider2Bib: t.rider2Bib ?? null,
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
