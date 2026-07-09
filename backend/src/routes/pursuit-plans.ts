// Zielpfad im Repo: backend/src/routes/pursuit-plans.ts  (ERSETZT die bestehende Datei)
// Änderungen ggü. Original:
//  - Sportlerauswahl/Führungsplan werden jetzt mitgespeichert (athleteMode/
//    athleteIds/fuehrungsplan, siehe schema.prisma)
//  - neue Route PATCH /:id zum Bearbeiten eines bestehenden Plans (Admin)
import { Router } from 'express';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';

const router = Router();

// ── GET /api/pursuit-plans — alle Pläne, öffentlich ──────────────────────────
router.get('/', async (_req, res) => {
  try {
    const plans = await prisma.pursuitPlan.findMany({
      orderBy: { createdAt: 'desc' },
    });
    res.json(plans);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Baut das Prisma-data-Objekt aus dem Request-Body — von POST und PATCH genutzt.
function buildPlanData(body: any) {
  const { trackM, numRounds, anfahrtSec, lapSec, totalSec, selectedKb, selectedRz, notes,
          athleteMode, athleteIds, fuehrungsplan } = body;
  return {
    trackM:        Number(trackM),
    numRounds:     Number(numRounds),
    anfahrtSec:    Number(anfahrtSec),
    lapSec:        Number(lapSec),
    totalSec:      Number(totalSec),
    selectedKb:    selectedKb != null ? Number(selectedKb) : null,
    selectedRz:    selectedRz != null ? Number(selectedRz) : null,
    notes:         notes ?? null,
    athleteMode:   athleteMode ?? null,
    athleteIds:    Array.isArray(athleteIds) ? athleteIds : [],
    fuehrungsplan: fuehrungsplan ?? undefined,
  };
}

// ── POST /api/pursuit-plans — nur Admin, löscht Pläne > 90 Tage ──────────────
router.post('/', requireAdmin, async (req, res) => {
  try {
    // Pläne älter als 90 Tage automatisch löschen
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await prisma.pursuitPlan.deleteMany({ where: { createdAt: { lt: cutoff } } });

    const plan = await prisma.pursuitPlan.create({ data: buildPlanData(req.body) });
    res.json(plan);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── PATCH /api/pursuit-plans/:id — bestehenden Plan überschreiben, nur Admin ─
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const plan = await prisma.pursuitPlan.update({
      where: { id: req.params.id },
      data: buildPlanData(req.body),
    });
    res.json(plan);
  } catch (e: any) {
    if (e.code === 'P2025') res.status(404).json({ error: 'Nicht gefunden' });
    else res.status(500).json({ error: String(e) });
  }
});

// ── DELETE /api/pursuit-plans/:id — nur Admin ─────────────────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await prisma.pursuitPlan.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;
