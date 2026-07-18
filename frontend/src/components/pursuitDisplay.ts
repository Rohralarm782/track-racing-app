// Zentrale Logik für die Vollbild-Athletenanzeige der Verfolgung.
// Farbe = Richtung (schneller/langsamer) je Palette; Opazität = Größe der
// Abweichung. Liefert fertige Container-/Textfarben, damit beide Timer
// (VerfolgungsplanungView, PursuitPage) UND die Einstellungs-Vorschau exakt
// dieselbe Anzeige verwenden — die Dublette von früher kann so nicht wieder
// auseinanderlaufen.

export type DScheme = 'light' | 'dark';
export type DFill = 'border' | 'full';
export type DNum = 'lap' | 'delta';
export type DPalette = 'gr' | 'bo';
export type DIntensity = 'const' | 'scaled';

export interface DisplaySettings {
  scheme: DScheme; fill: DFill; num: DNum;
  palette: DPalette; intensity: DIntensity;
  band: number; s0: number; s1: number;
}

export const DISPLAY_DEFAULTS: DisplaySettings = {
  scheme: 'light', fill: 'border', num: 'lap',
  palette: 'gr', intensity: 'const', band: 0.10, s0: 0.20, s1: 1.00,
};

const FLOOR = 0.10; // untere Deckung der Skala
type RGB = [number, number, number];
const HUES: Record<DPalette, { ahead: RGB; behind: RGB; neutral: RGB }> = {
  gr: { ahead: [22, 163, 74],  behind: [220, 38, 38],  neutral: [37, 99, 235] },   // grün/rot · auf Plan blau
  bo: { ahead: [37, 99, 235],  behind: [217, 119, 6],  neutral: [100, 116, 139] }, // blau/orange · auf Plan grau
};

// Liest die (geräteweiten) Einstellungen aus localStorage.
export function readDisplaySettings(): DisplaySettings {
  const g = (k: string) => localStorage.getItem('pursuitDisp.' + k);
  const n = (k: string, d: number) => { const v = parseFloat(g(k) || ''); return isNaN(v) ? d : v; };
  return {
    scheme:    (g('scheme') as DScheme) || DISPLAY_DEFAULTS.scheme,
    fill:      (g('fill') as DFill) || DISPLAY_DEFAULTS.fill,
    num:       (g('num') as DNum) || DISPLAY_DEFAULTS.num,
    palette:   (g('palette') as DPalette) || DISPLAY_DEFAULTS.palette,
    intensity: (g('intensity') as DIntensity) || DISPLAY_DEFAULTS.intensity,
    band: n('band', DISPLAY_DEFAULTS.band),
    s0:   n('s0', DISPLAY_DEFAULTS.s0),
    s1:   n('s1', DISPLAY_DEFAULTS.s1),
  };
}

function statusColor(delta: number | null, s: DisplaySettings): { hue: RGB; op: number } {
  const H = HUES[s.palette];
  const scaled = s.intensity === 'scaled';
  const m = delta === null ? 0 : Math.abs(delta);
  if (delta === null || m <= s.band) return { hue: H.neutral, op: scaled ? FLOOR : 1 };
  const hue = delta > 0 ? H.ahead : H.behind;
  if (!scaled) return { hue, op: 1 };
  const s1 = Math.max(s.s1, s.s0 + 0.01);
  let op: number;
  if (m <= s.s0) op = FLOOR;
  else if (m >= s1) op = 1;
  else op = FLOOR + (m - s.s0) / (s1 - s.s0) * (1 - FLOOR);
  return { hue, op };
}

function relLum([r, g, b]: RGB): number {
  const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export interface DisplayStyle {
  containerBg: string; containerBorder: string;
  bigColor: string; subColor: string; metaColor: string;
  tint: string; // Statusfarbe inkl. Opazität (für Vorschau-Rahmen)
}

// Berechnet aus Abweichung + Einstellungen alle Farben der Anzeige.
export function pursuitDisplayStyle(delta: number | null, s: DisplaySettings): DisplayStyle {
  const isDark = s.scheme === 'dark';
  const pageBg: RGB = isDark ? [0, 0, 0] : [255, 255, 255];
  const pageText = isDark ? '#ffffff' : '#0f172a';
  const pageMuted = isDark ? 'rgba(255,255,255,0.7)' : 'rgba(15,23,42,0.55)';
  const { hue, op } = statusColor(delta, s);
  const tint = `rgba(${hue[0]}, ${hue[1]}, ${hue[2]}, ${op})`;

  if (s.fill === 'full') {
    // Grund trägt die (ggf. blasse) Statusfarbe; Textfarbe nach tatsächlicher
    // Grundhelligkeit → immer lesbar, auch bei 10 %.
    const eff: RGB = [
      Math.round(pageBg[0] * (1 - op) + hue[0] * op),
      Math.round(pageBg[1] * (1 - op) + hue[1] * op),
      Math.round(pageBg[2] * (1 - op) + hue[2] * op),
    ];
    const light = relLum(eff) > 0.45;
    return {
      containerBg: `rgb(${eff[0]}, ${eff[1]}, ${eff[2]})`,
      containerBorder: 'none',
      bigColor: light ? '#0f172a' : '#ffffff',
      subColor: light ? 'rgba(15,23,42,0.75)' : 'rgba(255,255,255,0.85)',
      metaColor: light ? 'rgba(15,23,42,0.6)' : 'rgba(255,255,255,0.8)',
      tint,
    };
  }
  // Rahmenmodus: Schrift immer schwarz/weiß, Farbe nur im Rahmen.
  return {
    containerBg: isDark ? '#000000' : '#ffffff',
    containerBorder: `16px solid ${tint}`,
    bigColor: pageText,
    subColor: pageMuted,
    metaColor: pageMuted,
    tint,
  };
}
