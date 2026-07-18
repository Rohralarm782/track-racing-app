import { useState } from 'react';
import { pursuitDisplayStyle, DISPLAY_DEFAULTS } from './pursuitDisplay';
import type { DScheme, DFill, DNum, DPalette, DIntensity } from './pursuitDisplay';

// Zentrale Einstellungen für die Vollbild-Athletenanzeige der Verfolgung.
// Geräteweit über localStorage (kein Backend/Schema). Beide Timer und diese
// Vorschau nutzen dieselbe Logik aus pursuitDisplay.ts.

function Seg({ label, value, opts, onPick }: {
  label: string; value: string; opts: [string, string][]; onPick: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <div className="text-sm text-muted" style={{ width: 104, flex: '0 0 auto' }}>{label}</div>
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

function NumField({ label, value, step, onChange }: {
  label: string; value: number; step: number; onChange: (v: number) => void;
}) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 10, color: 'var(--c-text-muted)', marginBottom: 4, fontWeight: 600 }}>{label}</label>
      <input type="number" value={value} step={step} min={0}
        onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(Math.max(0, v)); }}
        style={{ width: '100%', background: 'var(--c-panel-2, #f8fafc)', border: '1px solid var(--c-border)',
          color: 'var(--c-text)', borderRadius: 8, padding: 8, fontSize: 15, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }} />
    </div>
  );
}

export default function PursuitDisplaySettings() {
  const g = (k: string) => localStorage.getItem('pursuitDisp.' + k);
  const gn = (k: string, d: number) => { const v = parseFloat(g(k) || ''); return isNaN(v) ? d : v; };

  const [scheme, setScheme]       = useState<DScheme>(() => (g('scheme') as DScheme) || DISPLAY_DEFAULTS.scheme);
  const [fill, setFill]           = useState<DFill>(() => (g('fill') as DFill) || DISPLAY_DEFAULTS.fill);
  const [num, setNum]             = useState<DNum>(() => (g('num') as DNum) || DISPLAY_DEFAULTS.num);
  const [palette, setPalette]     = useState<DPalette>(() => (g('palette') as DPalette) || DISPLAY_DEFAULTS.palette);
  const [intensity, setIntensity] = useState<DIntensity>(() => (g('intensity') as DIntensity) || DISPLAY_DEFAULTS.intensity);
  const [band, setBand]           = useState<number>(() => gn('band', DISPLAY_DEFAULTS.band));
  const [s0, setS0]               = useState<number>(() => gn('s0', DISPLAY_DEFAULTS.s0));
  const [s1, setS1]               = useState<number>(() => gn('s1', DISPLAY_DEFAULTS.s1));
  const [demo, setDemo]           = useState<number>(0.42); // Beispiel-Abweichung für die Vorschau

  function put(k: string, v: string) { localStorage.setItem('pursuitDisp.' + k, v); }
  const pickStr = <T extends string>(k: string, set: (v: T) => void) => (v: string) => { set(v as T); put(k, v); };
  const pickNum = (k: string, set: (v: number) => void) => (v: number) => { set(v); put(k, String(v)); };

  const cfg = { scheme, fill, num, palette, intensity, band, s0, s1 };
  const st = pursuitDisplayStyle(demo, cfg);
  const scaled = intensity === 'scaled';
  const demoTxt = `${demo > 0 ? '+' : ''}${demo.toFixed(2)}s`;
  const bigText = num === 'delta' ? demoTxt : '17.31s';
  const subText = num === 'delta' ? '17.31s' : demoTxt;

  return (
    <div className="card" style={{ marginBottom: 20, padding: 16 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 17 }}>🏁 Renntimer-Anzeige</h2>
      <p className="text-sm text-muted" style={{ marginTop: 0, marginBottom: 14 }}>
        Vollbild-Athletenanzeige der Verfolgung (gespeicherte wie neu erstellte Pläne). Auf diesem Gerät gespeichert.
      </p>

      <div style={{ display: 'grid', gap: 12, marginBottom: 14 }}>
        <Seg label="Farbe"       value={scheme}    onPick={pickStr<DScheme>('scheme', setScheme)}
             opts={[['light', 'Schwarz auf Weiß'], ['dark', 'Weiß auf Schwarz']]} />
        <Seg label="Statusfarben" value={palette}  onPick={pickStr<DPalette>('palette', setPalette)}
             opts={[['gr', 'Grün/Rot'], ['bo', 'Blau/Orange']]} />
        <Seg label="Anzeige"     value={fill}      onPick={pickStr<DFill>('fill', setFill)}
             opts={[['border', 'Rahmen'], ['full', 'Vollbild']]} />
        <Seg label="Große Zahl"  value={num}       onPick={pickStr<DNum>('num', setNum)}
             opts={[['lap', 'Rundenzeit'], ['delta', 'Abweichung']]} />
        <Seg label="Intensität"  value={intensity} onPick={pickStr<DIntensity>('intensity', setIntensity)}
             opts={[['const', 'Konstant'], ['scaled', 'Nach Abweichung']]} />
      </div>

      {scaled && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
          <NumField label="Neutralband (s)" value={band} step={0.05} onChange={pickNum('band', setBand)} />
          <NumField label="Skala von (s)"   value={s0}   step={0.05} onChange={pickNum('s0', setS0)} />
          <NumField label="Skala bis (s)"   value={s1}   step={0.1}  onChange={pickNum('s1', setS1)} />
        </div>
      )}

      {/* Vorschau */}
      <div style={{
        borderRadius: 12, height: 160,
        background: st.containerBg,
        border: st.containerBorder === 'none' ? '1px solid var(--c-border)' : `10px solid ${st.tint}`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{ fontSize: 11, color: st.metaColor, marginBottom: 4 }}>Vorschau · Runde 5 / 12</div>
        <div style={{ fontSize: 42, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1, letterSpacing: '-0.02em', color: st.bigColor }}>
          {bigText}
        </div>
        <div style={{ fontSize: 14, fontWeight: 500, marginTop: 6, color: st.subColor }}>
          {subText}
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--c-text-muted)', marginBottom: 4 }}>
          <span>Beispiel-Abweichung</span>
          <b style={{ color: 'var(--c-text)', fontVariantNumeric: 'tabular-nums' }}>{demoTxt}</b>
        </div>
        <input type="range" min={-150} max={150} value={Math.round(demo * 100)}
          onChange={e => setDemo(parseInt(e.target.value) / 100)}
          style={{ width: '100%', accentColor: 'var(--c-primary)' }} />
      </div>

      <p className="text-xs text-muted" style={{ marginTop: 10, marginBottom: 0 }}>
        „Nach Abweichung“: bis zum Neutralband ruhig, ab „Skala von“ beginnt die Farbfläche bei 10 % und wächst bis „Skala bis“ auf 100 %. Im Rahmenmodus bleibt die Schrift immer schwarz/weiß.
      </p>
    </div>
  );
}
