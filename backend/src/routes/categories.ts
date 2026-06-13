import { Router } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';

const router = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.get('/:id', async (req, res, next) => {
  try {
    const category = await prisma.category.findUnique({
      where: { id: req.params.id },
      include: {
        event: { select: { id: true, name: true, date: true } },
        teams: { orderBy: { number: 'asc' } },
        races: { orderBy: { order: 'asc' } },
      },
    });
    if (!category) { res.status(404).json({ error: 'Nicht gefunden' }); return; }
    res.json(category);
  } catch (e) { next(e); }
});

const CreateCategorySchema = z.object({
  eventId: z.string(),
  name: z.string().min(1),
  format: z.enum(['INDIVIDUAL', 'TEAM_PAIRS']).default('INDIVIDUAL'),
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = CreateCategorySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const category = await prisma.category.create({ data: parsed.data });
    res.status(201).json(category);
  } catch (e) { next(e); }
});

router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { name, format } = req.body;
    const data: Record<string, unknown> = {};
    if (name) data.name = name;
    if (format) data.format = format;
    const category = await prisma.category.update({ where: { id: req.params.id }, data: data as any });
    res.json(category);
  } catch (e) { next(e); }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.category.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (e) { next(e); }
});

// POST /api/categories/:id/import-pdf — Startliste per PDF importieren
router.post('/:id/import-pdf', requireAdmin, async (req, res, next) => {
  try {
    const { pdfBase64 } = req.body;
    if (!pdfBase64) { res.status(400).json({ error: 'pdfBase64 fehlt' }); return; }

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
          } as any,
          {
            type: 'text',
            text: `Dies ist eine Startliste oder Teilnehmerliste für ein Bahnradrennen.

Extrahiere alle Teilnehmer und gib NUR JSON zurück (kein Markdown):
{"teams":[{"number":1,"name":"Vorname Nachname","club":"Vereinsname"}]}

Regeln:
- number: Startnummer/BIB/StartNr als Ganzzahl
- name: "Vorname Nachname" (NICHT "Nachname Vorname")
- club: Vereinsname aus der Verein-Spalte
- Überspringe durchgestrichene Einträge
- Dedupliziere nach Nummer (z.B. Ballustrade/Messlinie-Doppelungen → nur einmal)
- Ignoriere: Platz, UCI-ID, LV, Q, V, R, Abschnittsüberschriften
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

export default router;
