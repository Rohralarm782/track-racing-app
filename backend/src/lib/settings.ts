import prisma from '../prisma';

const SETTINGS_ID = 'singleton';

/** Renndauer (Min.) getrennt nach Geschlecht — m = männlich, w = weiblich. */
export interface GenderMinutes {
  m: number;
  w: number;
}

export interface DistanceRaceMinutes {
  [distance: string]: GenderMinutes;
  default: GenderMinutes;
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

/**
 * Normalisiert einen einzelnen Distanz-Eintrag auf {m,w}. Akzeptiert dabei
 * BEIDE Formate:
 *   - alt (flach):  3.5            → { m: 3.5, w: 3.5 }  (Einzelwert für beide)
 *   - neu (m/w):    { m, w }       → unverändert; fehlt eine Seite, wird sie von
 *                                    der anderen bzw. dem Fallback aufgefüllt.
 * So ist die Umstellung rückwärtskompatibel und braucht keinen Backfill.
 */
function toGenderMinutes(value: unknown, fallback: GenderMinutes): GenderMinutes {
  if (typeof value === 'number') return { m: value, w: value };
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const m = typeof o.m === 'number' ? o.m : (typeof o.w === 'number' ? o.w : fallback.m);
    const w = typeof o.w === 'number' ? o.w : (typeof o.m === 'number' ? o.m : fallback.w);
    return { m, w };
  }
  return { ...fallback };
}

export function parseDistanceTable(json: unknown): DistanceRaceMinutes {
  const fallback: DistanceRaceMinutes = {
    '4000m': { m: 4.5, w: 4.5 }, '3000m': { m: 3.5, w: 3.5 }, '2000m': { m: 2.5, w: 2.5 },
    '1000m': { m: 1.1, w: 1.1 }, '500m': { m: 0.583, w: 0.583 }, default: { m: 3.0, w: 3.0 },
  };
  if (!json || typeof json !== 'object') return fallback;
  const obj = json as Record<string, unknown>;
  const result: DistanceRaceMinutes = {
    default: toGenderMinutes(obj.default, fallback.default),
  };
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'default') continue;
    result[key] = toGenderMinutes(value, fallback[key] ?? fallback.default);
  }
  return result;
}
