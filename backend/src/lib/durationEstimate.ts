import prisma from '../prisma';

const SETTINGS_ID = 'singleton';

export interface DistanceRaceMinutes {
  [distance: string]: number;
  default: number;
}

/**
 * Lädt die (einzige) Einstellungen-Zeile, legt sie mit Standardwerten an,
 * falls sie noch nicht existiert. Wird von durationEstimate.ts und
 * mevDetect.ts genutzt, damit die dortigen Formel-Werte/das LV-Kürzel nicht
 * mehr fest im Code stehen müssen.
 */
export async function getSettings() {
  const existing = await prisma.appSettings.findUnique({ where: { id: SETTINGS_ID } });
  if (existing) return existing;
  return prisma.appSettings.create({ data: { id: SETTINGS_ID } });
}

export function parseDistanceTable(json: unknown): DistanceRaceMinutes {
  const fallback: DistanceRaceMinutes = {
    '4000m': 4.5, '3000m': 3.5, '2000m': 2.5, '1000m': 1.1, '500m': 0.583, default: 3.0,
  };
  if (!json || typeof json !== 'object') return fallback;
  const obj = json as Record<string, unknown>;
  const result: DistanceRaceMinutes = { default: typeof obj.default === 'number' ? obj.default : 3.0 };
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'number') result[key] = value;
  }
  return result;
}
