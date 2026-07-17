import { useState } from 'react';

// Zentrale Einstellungen für die Vollbild-Athletenanzeige der Verfolgung.
// Bewusst geräteweit über localStorage (kein Backend/Schema) — die Anzeige
// läuft auf dem Gerät des Bedieners, dort werden die Werte gelesen. Beide
// Timer-Implementierungen (RenntimerView in VerfolgungsplanungView UND die
// PursuitPage-Anzeige) lesen exakt dieselben Schlüssel: pursuitDisp.*

type DScheme = 'light' | 'dark';
type DFill = 'border' | 'full';
type DNum = 'lap' | 'delta';

function Seg({ label, value, opts, onPick }: {
  label: string; value: string; opts: [string, string][]; onPick: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <div className="text-sm text-muted" style={{ width: 96, flex: '0 0 auto' }}>{label}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {opts.map(([v, lbl]) => {
          const active = v === value;
          return (
            <button key={v} onClick={() => onPick(v)} style={{
              padding: '7px 12px', borderRadius: 7, fontSize: 13, cursor: 'pointer',
              border: active ? '2px solid var(--c-primary)' : '1px solid var(--c-border)',
              background: active ? '#dbeafe' : 'var(--c-white)',
              color: active ? 'var(--c-primary)' : 'var(--c-text)',
              fontWeight: active ? 700 : 400,
            }}>{lbl}</button>
          );
        })}
      </div>
    </div>
  );
}

export default function PursuitDisplaySettings() {
  const [scheme, setScheme] = useState<DScheme>(() => (localStorage.getItem('pursuitDisp.scheme') as DScheme) || 'light');
  const [fill, setFill]     = useState<DFill>(()   => (localStorage.getItem('pursuitDisp.fill')   as DFill)   || 'border');
  const [num, setNum]       = useState<DNum>(()    => (localStorage.getItem('pursuitDisp.num')    as DNum)    || 'lap');

  function pickScheme(v: string) { const s = v as DScheme; setScheme(s); localStorage.setItem('pursuitDisp.scheme', s); }
  function pickFill(v: string)   { const s = v as DFill;   setFill(s);   localStorage.setItem('pursuitDisp.fill', s); }
  function pickNum(v: string)    { const s = v as DNum;    setNum(s);    localStorage.setItem('pursuitDisp.num', s); }

  // ── Vorschau (Beispiel: schnelle Runde → grün) ─────────────────────────────
  const status   = 'var(--c-success)';
  const isDark   = scheme === 'dark';
  const filled   = fill === 'full';
  const pageBg   = isDark ? '#000000' : 'var(--c-white)';
  const pageText = isDark ? '#ffffff' : 'var(--c-text)';
  const bigText  = num === 'delta' ? '+0.42s' : '17.31s';
  const subText  = num === 'delta' ? '17.31s' : '+0.42s';
  const bigColor = filled ? '#ffffff' : (num === 'delta' ? status : pageText);
  const subColor = filled ? 'rgba(255,255,255,0.85)' : (num === 'delta' ? pageText : status);
  const metaColor = filled ? 'rgba(255,255,255,0.85)' : 'var(--c-text-muted)';

  return (
    <div className="card" style={{ marginBottom: 20, padding: 16 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 17 }}>🏁 Renntimer-Anzeige</h2>
      <p className="text-sm text-muted" style={{ marginTop: 0, marginBottom: 14 }}>
        Vollbild-Athletenanzeige der Verfolgung (Einzel- und Mannschaftsverfolgung,
        gespeicherte Pläne wie neu erstellte). Auf diesem Gerät gespeichert.
      </p>

      <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
        <Seg label="Farbe"      value={scheme} onPick={pickScheme}
             opts={[['light', 'Schwarz auf Weiß'], ['dark', 'Weiß auf Schwarz']]} />
        <Seg label="Anzeige"    value={fill}   onPick={pickFill}
             opts={[['border', 'Rahmen'], ['full', 'Vollbild']]} />
        <Seg label="Große Zahl" value={num}    onPick={pickNum}
             opts={[['lap', 'Rundenzeit'], ['delta', 'Abweichung']]} />
      </div>

      <div style={{
        borderRadius: 12, height: 156,
        background: filled ? status : pageBg,
        border: filled ? '1px solid var(--c-border)' : `10px solid ${status}`,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{ fontSize: 11, color: metaColor, marginBottom: 4 }}>Vorschau · Runde 5 / 12</div>
        <div style={{ fontSize: 52, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1, letterSpacing: '-0.02em', color: bigColor }}>
          {bigText}
        </div>
        <div style={{ fontSize: 14, fontWeight: 500, marginTop: 6, color: subColor }}>
          {subText}
        </div>
      </div>

      <p className="text-xs text-muted" style={{ marginTop: 10, marginBottom: 0 }}>
        Tipp: outdoor „Schwarz auf Weiß“ + „Vollbild“ (unübersehbar in der Sonne),
        indoor „Weiß auf Schwarz“ + „Rahmen“ (augenschonend).
      </p>
    </div>
  );
}
