const SPRINT_POINTS: Record<number, number> = { 1: 5, 2: 3, 3: 2, 4: 1 };
const LAP_POINTS = 20;

export interface TeamStanding {
  teamId: string; teamNumber: number; teamName: string;
  club?: string | null; lv?: string | null; rider2Lv?: string | null;
  rider1?: string | null; rider2?: string | null;
  isFavorite?: boolean; isDsq?: boolean; isWarned?: boolean;
  total: number; sprintPoints: number; lapPoints: number; omniumPoints: number;
  wins: number; seconds: number; thirds: number; fourths: number;
  lapBalance: number; finalePosition?: number | null;
}

interface Team {
  id: string; number: number; name: string;
  club?: string | null; lv?: string | null; rider2Lv?: string | null;
  isFavorite?: boolean;
  rider1?: string | null; rider2?: string | null;
}
interface SprintResult { teamId: string; position: number; }
interface Sprint { isFinale: boolean; results: SprintResult[]; }
interface LapEvent { teamId: string; delta: number; }
interface OmniumScore { teamId: string; points: number; }
interface Flag { teamId: string; type: string; }

function baseMap(teams: Team[], flags: Flag[], omniumMap: Map<string, number>) {
  const dsqIds  = new Set(flags.filter(f => f.type === 'DSQ').map(f => f.teamId));
  const warnIds = new Set(flags.filter(f => f.type === 'WARNING').map(f => f.teamId));
  const map = new Map<string, TeamStanding>();
  for (const team of teams) {
    const omniumPoints = omniumMap.get(team.id) ?? 0;
    map.set(team.id, {
      teamId: team.id, teamNumber: team.number, teamName: team.name,
      club: team.club ?? null, lv: team.lv ?? null, rider2Lv: team.rider2Lv ?? null,
      rider1: team.rider1, rider2: team.rider2,
      isFavorite: team.isFavorite ?? false,
      isDsq: dsqIds.has(team.id), isWarned: warnIds.has(team.id),
      total: 0, sprintPoints: 0,
      lapPoints: omniumPoints, omniumPoints,
      wins: 0, seconds: 0, thirds: 0, fourths: 0,
      lapBalance: 0, finalePosition: null,
    });
  }
  return map;
}

// ─── Punktefahren ─────────────────────────────────────────────────────────────

export function computePunktefahren(
  teams: Team[], sprints: Sprint[], lapEvents: LapEvent[],
  omniumScores: OmniumScore[], flags: Flag[] = [],
): TeamStanding[] {
  const omniumMap = new Map(omniumScores.map(o => [o.teamId, o.points]));
  const map = baseMap(teams, flags, omniumMap);

  const finaleSprint = sprints.find(s => s.isFinale);
  if (finaleSprint) {
    for (const r of finaleSprint.results) {
      const s = map.get(r.teamId);
      if (s) s.finalePosition = r.position;
    }
  }

  for (const sprint of sprints) {
    const mult = sprint.isFinale ? 2 : 1;
    for (const r of sprint.results) {
      const s = map.get(r.teamId); if (!s) continue;
      s.sprintPoints += (SPRINT_POINTS[r.position] ?? 0) * mult;
      if (r.position === 1) s.wins++;
      else if (r.position === 2) s.seconds++;
      else if (r.position === 3) s.thirds++;
      else if (r.position === 4) s.fourths++;
    }
  }

  for (const lap of lapEvents) {
    const s = map.get(lap.teamId); if (!s) continue;
    s.lapBalance += lap.delta;
    s.lapPoints += lap.delta * LAP_POINTS;
  }

  return [...map.values()]
    .map(s => ({ ...s, total: s.isDsq ? 0 : s.sprintPoints + s.lapPoints }))
    .sort((a, b) => {
      if (a.isDsq !== b.isDsq) return a.isDsq ? 1 : -1;
      if (a.isDsq && b.isDsq) return 0;
      if (b.total !== a.total) return b.total - a.total;
      if (finaleSprint) {
        const aF = a.finalePosition ?? 99;
        const bF = b.finalePosition ?? 99;
        if (aF !== bF) return aF - bF;
      }
      return 0;
    });
}

// ─── Temporunden ──────────────────────────────────────────────────────────────
// Punkte:
//   Reguläre Runde (isFinale=false): 1 Punkt für den Rundensieger (position 1)
//   Schlusswertung (isFinale=true):  5-3-2-1 für Plätze 1-4
//   Rundengewinn/-verlust:           ±20 Punkte (identisch zu Punktefahren)
//   Gleichstand:                     Platz in der Schlusswertung entscheidet

export function computeTemporennen(
  teams: Team[], sprints: Sprint[], lapEvents: LapEvent[],
  flags: Flag[] = [],
): TeamStanding[] {
  const map = baseMap(teams, flags, new Map());

  for (const sprint of sprints) {
    if (sprint.results.length === 0) continue; // übersprungene Runde

    if (sprint.isFinale) {
      // Schlusswertung: 1 Punkt für Platz 1, alle Platzierungen für Gleichstand
      for (const r of sprint.results) {
        const s = map.get(r.teamId); if (!s) continue;
        s.finalePosition = r.position;
        if (r.position === 1) { s.sprintPoints += 1; s.wins++; }
      }
    } else {
      // Reguläre Runde: 1 Punkt für Sieger
      const winner = sprint.results.find(r => r.position === 1);
      if (winner) {
        const s = map.get(winner.teamId); if (!s) continue;
        s.sprintPoints += 1;
        s.wins++;
      }
    }
  }

  for (const lap of lapEvents) {
    const s = map.get(lap.teamId); if (!s) continue;
    s.lapBalance += lap.delta;
    s.lapPoints += lap.delta * LAP_POINTS;
  }

  return [...map.values()]
    .map(s => ({ ...s, total: s.isDsq ? 0 : s.sprintPoints + s.lapPoints }))
    .sort((a, b) => {
      if (a.isDsq !== b.isDsq) return a.isDsq ? 1 : -1;
      if (a.isDsq && b.isDsq) return 0;
      if (b.total !== a.total) return b.total - a.total;
      // Gleichstand: Schlusswertungsplatz
      const aF = a.finalePosition ?? 99;
      const bF = b.finalePosition ?? 99;
      return aF - bF;
    });
}
