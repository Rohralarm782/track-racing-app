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

// ── POST /api/pursuit-plans — nur Admin, löscht Pläne > 90 Tage ──────────────
router.post('/', requireAdmin, async (req, res) => {
  const { trackM, numRounds, anfahrtSec, lapSec, totalSec, selectedKb, selectedRz, notes } = req.body;
  try {
    // Pläne älter als 90 Tage automatisch löschen
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await prisma.pursuitPlan.deleteMany({ where: { createdAt: { lt: cutoff } } });

    const plan = await prisma.pursuitPlan.create({
      data: {
        trackM:     Number(trackM),
        numRounds:  Number(numRounds),
        anfahrtSec: Number(anfahrtSec),
        lapSec:     Number(lapSec),
        totalSec:   Number(totalSec),
        selectedKb: selectedKb != null ? Number(selectedKb) : null,
        selectedRz: selectedRz != null ? Number(selectedRz) : null,
        notes:      notes ?? null,
      },
    });
    res.json(plan);
  } catch (e) {
    res.status(500).json({ error: String(e) });
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
