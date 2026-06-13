const SPRINT_POINTS: Record<number, number> = { 1: 5, 2: 3, 3: 2, 4: 1 };
const LAP_POINTS = 20;

export interface TeamStanding {
  teamId: string;
  teamNumber: number;
  teamName: string;
  rider1?: string | null;
  rider2?: string | null;
  total: number;
  sprintPoints: number;
  lapPoints: number;
  omniumPoints: number;
  wins: number;
  seconds: number;
  thirds: number;
  fourths: number;
  lapBalance: number;
  finalePosition?: number | null;
}

interface Team { id: string; number: number; name: string; rider1?: string|null; rider2?: string|null; }
interface SprintResult { teamId: string; position: number; }
interface Sprint { isFinale: boolean; results: SprintResult[]; }
interface LapEvent { teamId: string; delta: number; }
interface OmniumScore { teamId: string; points: number; }

export function computePunktefahren(
  teams: Team[],
  sprints: Sprint[],
  lapEvents: LapEvent[],
  omniumScores: OmniumScore[],
): TeamStanding[] {
  const omniumMap = new Map(omniumScores.map(o => [o.teamId, o.points]));
  const map = new Map<string, TeamStanding>();

  for (const team of teams) {
    const omniumPoints = omniumMap.get(team.id) ?? 0;
    map.set(team.id, {
      teamId: team.id, teamNumber: team.number, teamName: team.name,
      rider1: team.rider1, rider2: team.rider2,
      total: 0, sprintPoints: 0,
      lapPoints: omniumPoints, omniumPoints,
      wins: 0, seconds: 0, thirds: 0, fourths: 0,
      lapBalance: 0, finalePosition: null,
    });
  }

  // Finale-Platzierung ermitteln (Tiebreaker bei Punktgleichheit)
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
    .map(s => ({ ...s, total: s.sprintPoints + s.lapPoints }))
    .sort((a, b) => {
      // 1. Gesamtpunkte
      if (b.total !== a.total) return b.total - a.total;
      // 2. Bei Punktgleichheit: Finale-Platzierung (niedriger = besser, kein Platz = letzter)
      return (a.finalePosition ?? 99) - (b.finalePosition ?? 99);
    });
}
