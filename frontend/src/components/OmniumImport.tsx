import { useEffect, useState } from 'react';
import { api, type Event, type RaceType } from '../api/client';

interface Props {
  eventId: string;
  event: Event;
  initialBase64: string;
  onDone: () => void;
  onClose: () => void;
}

type Step = 'pick-race' | 'applying' | 'done';

const RACE_TYPE_LABEL: Record<RaceType, string> = {
  PUNKTEFAHREN: 'Punktefahren',
  TEMPORUNDEN: 'Temporunden',
  VERFOLGUNGSRENNEN: 'Verfolgungsrennen',
};

interface PickableRace {
  id: string;
  label: string;
  type: RaceType;
}

/**
 * Importiert eine Omnium-Zwischenwertung (z.B. "K72") direkt auf ein
 * bestehendes Rennen — die Punktestände fließen als Vorpunkte ins
 * Punktefahren ein. Anders als die Ansetzung legt das kein neues Rennen an,
 * das Rennen muss schon existieren (normalerweise vorher per
 * Ansetzung-Import erstellt).
 */
export default function OmniumImport({ eventId, event, initialBase64, onDone, onClose }: Props) {
  const [step, setStep] = useState<Step>('pick-race');
  const [error, setError] = useState('');
  const [selectedRaceId, setSelectedRaceId] = useState('');
  const [result, setResult] = useState<{ imported: number; total: number } | null>(null);

  const pickableRaces: PickableRace[] = [
    ...event.categories.flatMap(cat =>
      (cat.races ?? []).map(r => ({ id: r.id, label: `${cat.name} · ${r.name}`, type: r.type }))
    ),
    ...(event.races ?? []).map(r => ({ id: r.id, label: `${r.ak ? r.ak + ' · ' : ''}${r.name}`, type: r.type })),
  ];

  useEffect(() => {
    if (pickableRaces.length === 1) setSelectedRaceId(pickableRaces[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function apply() {
    if (!selectedRaceId) { setError('Bitte ein Rennen auswählen.'); return; }
    setStep('applying'); setError('');
    try {
      const res = await api.post<{ imported: number; total: number }>(
        `/api/races/${selectedRaceId}/omnium-pdf`,
        { pdfBase64: initialBase64 },
      );
      setResult(res);
      setStep('done');
    } catch (e: any) {
      setError(e.message ?? 'Import fehlgeschlagen');
      setStep('pick-race');
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(17,17,17,0.6)',
      zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{
        background: 'var(--c-white)', borderRadius: 12, width: '100%', maxWidth: 460,
        maxHeight: '90vh', overflowY: 'auto', padding: 20,
      }}>
        <div className="flex-between mb-3">
          <h3 style={{ margin: 0 }}>📊 Omnium-Vorpunkte importieren</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        {error && <div className="alert alert-error mb-3">{error}</div>}

        {(step === 'pick-race' || step === 'applying') && (
          <>
            <p className="text-sm text-muted" style={{ marginTop: 0 }}>
              Für welches Rennen gelten diese Punktestände?
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
              {pickableRaces.map(race => (
                <label
                  key={race.id}
                  className="card"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', cursor: 'pointer',
                    borderColor: selectedRaceId === race.id ? 'var(--c-primary)' : 'var(--c-border)',
                    background: selectedRaceId === race.id ? '#eff6ff' : 'var(--c-white)',
                  }}
                >
                  <input
                    type="radio"
                    name="omnium-race-pick"
                    checked={selectedRaceId === race.id}
                    onChange={() => setSelectedRaceId(race.id)}
                  />
                  <span style={{ fontSize: 13 }}>
                    <strong>{race.label}</strong> <span className="text-muted">({RACE_TYPE_LABEL[race.type]})</span>
                  </span>
                </label>
              ))}
              {pickableRaces.length === 0 && (
                <p className="text-sm text-muted">
                  Noch keine Rennen angelegt — importiert zuerst die Ansetzung für das Punktefahren.
                </p>
              )}
            </div>

            <button
              className="btn btn-primary btn-block"
              onClick={apply}
              disabled={step === 'applying' || !selectedRaceId}
            >
              {step === 'applying' ? 'Importiere…' : 'Vorpunkte importieren'}
            </button>
          </>
        )}

        {step === 'done' && result && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <p style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>✅ Vorpunkte importiert</p>
            <p className="text-sm text-muted" style={{ marginBottom: 20 }}>
              {result.imported} von {result.total} Einträgen zugeordnet
              {result.imported < result.total && ' (Rest ohne passendes Team im Rennen)'}
            </p>
            <button className="btn btn-primary btn-block" onClick={onDone}>Fertig</button>
          </div>
        )}
      </div>
    </div>
  );
}
