import { useEffect, useState } from 'react';
import { settingsApi, type AppSettings, type DurationEstimateRow } from '../api/client';

// Kleines wiederverwendbares Zahlenfeld für die vielen Formel-Werte unten.
function NumField({
  label, value, onChange, step = 0.1, suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  suffix?: string;
}) {
  return (
    <div className="form-group" style={{ margin: 0 }}>
      <label className="form-label" style={{ fontSize: 12 }}>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="number"
          className="form-input"
          value={value}
          step={step}
          onChange={e => onChange(Number(e.target.value))}
          style={{ fontSize: 13, padding: '5px 8px' }}
        />
        {suffix && <span style={{ fontSize: 11, color: 'var(--c-text-muted)', whiteSpace: 'nowrap' }}>{suffix}</span>}
      </div>
    </div>
  );
}

export default function TimeEstimateSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [calibration, setCalibration] = useState<DurationEstimateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true); setError('');
    try {
      const [s, c] = await Promise.all([settingsApi.get(), settingsApi.getCalibration()]);
      setSettings(s);
      setCalibration(c);
    } catch (e: any) {
      setError(e.message ?? 'Laden fehlgeschlagen');
    } finally {
      setLoading(false);
    }
  }

  function patch(partial: Partial<AppSettings>) {
    setSettings(s => s ? { ...s, ...partial } : s);
    setSaved(false);
  }

  function patchDistance(key: string, value: number) {
    setSettings(s => s ? { ...s, distanceRaceMinutes: { ...s.distanceRaceMinutes, [key]: value } } : s);
    setSaved(false);
  }

  async function save() {
    if (!settings) return;
    setSaving(true); setError('');
    try {
      const updated = await settingsApi.update(settings);
      setSettings(updated);
      setSaved(true);
    } catch (e: any) {
      setError(e.message ?? 'Speichern fehlgeschlagen');
    } finally {
      setSaving(false);
    }
  }

  async function resetCategory(id: string) {
    if (!window.confirm('Diese Kategorie auf den Ausgangswert (Korrekturfaktor 1.0) zurücksetzen?')) return;
    try {
      await settingsApi.resetCalibration(id);
      setCalibration(c => c.filter(row => row.id !== id));
    } catch (e: any) {
      setError(e.message ?? 'Zurücksetzen fehlgeschlagen');
    }
  }

  if (loading) return <div className="loading"><span className="spinner" /> Lädt…</div>;
  if (!settings) return <div className="alert alert-error">{error || 'Einstellungen konnten nicht geladen werden'}</div>;

  const distances = settings.distanceRaceMinutes ?? {};

  return (
    <div>
      {error && <div className="alert alert-error mb-3">{error}</div>}

      <div className="card mb-3">
        <p className="text-sm" style={{ fontWeight: 600, marginBottom: 4 }}>Landesverband</p>
        <p className="text-xs text-muted" style={{ marginBottom: 10 }}>
          Kürzel, nach dem in Startlisten gesucht wird (Fahrer-Erkennung, Lauf-Nummer, Team-Namen).
        </p>
        <div className="form-group" style={{ margin: 0, maxWidth: 160 }}>
          <input
            type="text"
            className="form-input"
            value={settings.mevLv}
            onChange={e => patch({ mevLv: e.target.value })}
          />
        </div>
      </div>

      <div className="card mb-3">
        <p className="text-sm" style={{ fontWeight: 600, marginBottom: 10 }}>Massenstart (Punktefahren, Madison, Scratch, Temporunden, Omnium)</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <NumField label="Startaufstellung" value={settings.massStartSetupMin} suffix="Min." onChange={v => patch({ massStartSetupMin: v })} />
          <NumField label="Pro Runde" value={Math.round(settings.massStartPerRoundMin * 60)} step={1} suffix="Sek." onChange={v => patch({ massStartPerRoundMin: v / 60 })} />
          <NumField label="Abräumen" value={settings.massStartClearMin} suffix="Min." onChange={v => patch({ massStartClearMin: v })} />
        </div>
      </div>

      <div className="card mb-3">
        <p className="text-sm" style={{ fontWeight: 600, marginBottom: 10 }}>Ausscheidungsfahren</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <NumField label="Startaufstellung" value={settings.afSetupMin} suffix="Min." onChange={v => patch({ afSetupMin: v })} />
          <NumField label="Pro Runde" value={Math.round(settings.afPerRoundMin * 60)} step={1} suffix="Sek." onChange={v => patch({ afPerRoundMin: v / 60 })} />
          <NumField label="Abräumen" value={settings.afClearMin} suffix="Min." onChange={v => patch({ afClearMin: v })} />
        </div>
      </div>

      <div className="card mb-3">
        <p className="text-sm" style={{ fontWeight: 600, marginBottom: 4 }}>Verfolgung / Zeitfahren</p>
        <p className="text-xs text-muted" style={{ marginBottom: 10 }}>Pro Lauf = Startaufstellung + übliche Renndauer nach Distanz.</p>
        <div style={{ marginBottom: 10, maxWidth: 160 }}>
          <NumField label="Startaufstellung/Lauf" value={settings.pursuitSetupMin} suffix="Min." onChange={v => patch({ pursuitSetupMin: v })} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          {Object.entries(distances).filter(([k]) => k !== 'default').map(([dist, min]) => (
            <NumField
              key={dist}
              label={dist}
              value={min}
              step={0.1}
              suffix="Min."
              onChange={v => patchDistance(dist, v)}
            />
          ))}
          <NumField label="unbekannte Distanz" value={distances.default ?? 3} suffix="Min." onChange={v => patchDistance('default', v)} />
        </div>
      </div>

      <div className="card mb-3">
        <p className="text-sm" style={{ fontWeight: 600, marginBottom: 10 }}>Sprint / Teamsprint / Keirin (pro Lauf)</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <NumField label="Sprint" value={settings.sprintPerHeatMin} suffix="Min." onChange={v => patch({ sprintPerHeatMin: v })} />
          <NumField label="Teamsprint" value={settings.teamsprintPerHeatMin} suffix="Min." onChange={v => patch({ teamsprintPerHeatMin: v })} />
          <NumField label="Keirin" value={settings.keirinPerHeatMin} suffix="Min." onChange={v => patch({ keirinPerHeatMin: v })} />
        </div>
      </div>

      <div className="card mb-3">
        <p className="text-sm" style={{ fontWeight: 600, marginBottom: 10 }}>Anzeige</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <NumField label="Cool-down zwischen Blöcken" value={settings.pauseBufferMin} step={1} suffix="Min." onChange={v => patch({ pauseBufferMin: v })} />
          <NumField label="Schätzung anzeigen ab" value={settings.estimateThresholdMin} step={1} suffix="Min. Abweichung" onChange={v => patch({ estimateThresholdMin: v })} />
        </div>
      </div>

      <div className="card mb-3">
        <p className="text-sm" style={{ fontWeight: 600, marginBottom: 4 }}>Rückfallgrößen</p>
        <p className="text-xs text-muted" style={{ marginBottom: 10 }}>Werden verwendet, wenn die Startliste keine Runden-/Laufzahl hergibt.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <NumField label="Punktefahren (Runden)" value={settings.fallbackRoundCountPr} step={1} onChange={v => patch({ fallbackRoundCountPr: v })} />
          <NumField label="Temporunden (Runden)" value={settings.fallbackRoundCountTr} step={1} onChange={v => patch({ fallbackRoundCountTr: v })} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <NumField label="Andere Massenstart" value={settings.fallbackRoundCountDefault} step={1} onChange={v => patch({ fallbackRoundCountDefault: v })} />
          <NumField label="Einzelstart generisch" value={settings.fallbackHeatCount} step={1} onChange={v => patch({ fallbackHeatCount: v })} />
          <NumField label="Verfolgung-Finale" value={settings.pursuitFinalHeatCount} step={1} onChange={v => patch({ pursuitFinalHeatCount: v })} />
        </div>
      </div>

      <div className="flex-between mb-4">
        {saved && <span className="text-xs" style={{ color: 'var(--c-success, #16a34a)' }}>✓ Gespeichert</span>}
        <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={save} disabled={saving}>
          {saving ? 'Speichert…' : 'Einstellungen speichern'}
        </button>
      </div>

      <div className="card">
        <p className="text-sm" style={{ fontWeight: 600, marginBottom: 4 }}>Kalibrierung</p>
        <p className="text-xs text-muted" style={{ marginBottom: 10 }}>
          Korrekturfaktor pro Kategorie, gelernt aus echten "Aktueller Stand"-Meldungen. 1.0 = Ausgangsformel unverändert.
        </p>
        {calibration.length === 0 ? (
          <p className="text-sm text-muted">Noch keine Beobachtungen.</p>
        ) : (
          <div>
            {calibration.map(row => (
              <div
                key={row.id}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--c-border)' }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13 }}>
                    {row.ak} · {row.disciplineLabel} {row.massStart ? '' : '(Einzelstart)'}
                  </div>
                  <div className="text-xs text-muted">
                    Faktor {row.correctionFactor.toFixed(2)} · {row.sampleCount} {row.sampleCount === 1 ? 'Beobachtung' : 'Beobachtungen'}
                  </div>
                </div>
                <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, flexShrink: 0 }} onClick={() => resetCategory(row.id)}>
                  Zurücksetzen
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
