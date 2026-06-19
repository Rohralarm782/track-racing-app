import { Router } from 'express';
import prisma from '../prisma';

const router = Router();

// ── GET /api/pursuit-plans/latest — öffentlich, kein Login nötig ──────────────
router.get('/latest', async (_req, res) => {
  try {
    const plan = await prisma.pursuitPlan.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    res.json(plan ?? null);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /api/pursuit-plans — nur Admin ───────────────────────────────────────
router.post('/', async (req, res) => {
  if (!(req as any).session?.isAdmin) {
    return res.status(403).json({ error: 'Nicht autorisiert' });
  }
  const { trackM, numRounds, anfahrtSec, lapSec, totalSec, selectedKb, selectedRz, notes } = req.body;
  try {
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
router.delete('/:id', async (req, res) => {
  if (!(req as any).session?.isAdmin) {
    return res.status(403).json({ error: 'Nicht autorisiert' });
  }
  try {
    await prisma.pursuitPlan.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;
