import { Router } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';
import { getSettings } from '../lib/settings';

const router = Router();

// GET /api/settings — aktuelle allgemeine Einstellungen (Formel-Werte, LV-Kürzel, ...)
router.get('/', async (req, res, next) => {
  try {
    res.json(await getSettings());
  } catch (e) { next(e); }
});

const SettingsSchema = z.object({
  mevLv: z.string().min(1).max(20).optional(),
  massStartSetupMin: z.number().min(0).optional(),
  massStartPerRoundMin: z.number().min(0).optional(),
  massStartClearMin: z.number().min(0).optional(),
  afSetupMin: z.number().min(0).optional(),
  afPerRoundMin: z.number().min(0).optional(),
  afClearMin: z.number().min(0).optional(),
  pursuitSetupMin: z.number().min(0).optional(),
  // Neu: Renndauer je Distanz getrennt nach m/w. Alte Flat-Zahlen bleiben
  // zulässig (werden serverseitig via parseDistanceTable auf {m,w} migriert).
  distanceRaceMinutes: z
    .record(
      z.union([
        z.number().min(0),
        z.object({ m: z.number().min(0), w: z.number().min(0) }),
      ]),
    )
    .optional(),
  sprintPerHeatMin: z.number().min(0).optional(),
  teamsprintPerHeatMin: z.number().min(0).optional(),
  keirinPerHeatMin: z.number().min(0).optional(),
  pauseBufferMin: z.number().int().min(0).optional(),
  estimateThresholdMin: z.number().int().min(0).optional(),
  fallbackRoundCountPr: z.number().int().min(0).optional(),
  fallbackRoundCountTr: z.number().int().min(0).optional(),
  fallbackRoundCountDefault: z.number().int().min(0).optional(),
  fallbackHeatCount: z.number().int().min(0).optional(),
  pursuitFinalHeatCount: z.number().int().min(0).optional(),
});

// PUT /api/settings — Einstellungen aktualisieren (nur übergebene Felder ändern sich)
router.put('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = SettingsSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    await getSettings(); // stellt sicher, dass die Zeile existiert (legt sie ggf. an)
    const updated = await prisma.appSettings.update({
      where: { id: 'singleton' },
      data: parsed.data as any,
    });
    res.json(updated);
  } catch (e) { next(e); }
});

// GET /api/settings/calibration — alle kalibrierten Kategorien (Korrekturfaktor + Beobachtungszahl)
router.get('/calibration', async (req, res, next) => {
  try {
    const rows = await prisma.durationEstimate.findMany({ orderBy: [{ ak: 'asc' }, { disciplineLabel: 'asc' }] });
    res.json(rows);
  } catch (e) { next(e); }
});

// DELETE /api/settings/calibration/:id — eine Kategorie auf den Ausgangszustand zurücksetzen
// (löscht die Zeile komplett; beim nächsten Mal wird sie mit correctionFactor 1.0 neu angelegt)
router.delete('/calibration/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.durationEstimate.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (e) { next(e); }
});

export default router;
