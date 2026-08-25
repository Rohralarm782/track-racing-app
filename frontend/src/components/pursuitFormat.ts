// Zielpfad im Repo: frontend/src/components/pursuitFormat.ts  (NEUE Datei)
//
// Gemeinsame Formatierung und Konstanten für alles rund um die Verfolgung.
// Vorher lagen diese Funktionen doppelt in VerfolgungsplanungView.tsx und
// PursuitPage.tsx — mit minimal unterschiedlichem Verhalten (fmtSec vs fmtTime).
// Ab jetzt gibt es genau eine Fassung, damit Rechner, Renntimer und Planliste
// dieselbe Zeit auch gleich anzeigen.

/** Ein getippter Zeitstempel im Renntimer. `ts` ist performance.now(), also
 *  monoton und ohne Sprünge bei Uhrzeitkorrekturen — die Wanduhrzeit des Starts
 *  wird beim CSV-Export aus dem Offset rekonstruiert. */
export interface TEvent { ts: number; type: 'start' | 'lap' | 'half'; }

/** Sekunden Abweichung, ab der die Anzeige die Farbe wechselt. Darunter gilt
 *  der Lauf als „im Plan" — alles andere wäre Scheingenauigkeit beim Tippen. */
export const TOLERANCE = 0.2;

/** Sekunden, die die Vollbild-Athletenanzeige nach jeder Runde stehen bleibt. */
export const DISPLAY_SEC = 8;

/** 3:45.02 ab einer Minute, sonst 45.02s. */
export function fmtTime(secs: number): string {
  if (isNaN(secs) || secs < 0) return '–';
  if (secs < 60) return secs.toFixed(2) + 's';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${(s < 10 ? '0' : '')}${s.toFixed(2)}`;
}

/** Farbe und Label für eine Abweichung zum Plan. Positiv = schneller als Plan
 *  (Plan minus Ist), deshalb ist ▲ grün. */
export function diffStyle(diff: number | null): { border: string; text: string; label: string } {
  if (diff === null) return { border: 'var(--c-border)', text: 'var(--c-text-muted)', label: '–' };
  if (diff >  TOLERANCE) return { border: 'var(--c-success)', text: 'var(--c-success)', label: `▲ +${diff.toFixed(2)}s` };
  if (diff < -TOLERANCE) return { border: 'var(--c-danger)',  text: 'var(--c-danger)',  label: `▼ ${diff.toFixed(2)}s`  };
  return { border: 'var(--c-primary)', text: 'var(--c-primary)', label: `= ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}s` };
}
