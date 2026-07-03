import { useEffect, useState } from 'react';
import { api, type Event, type RaceType } from '../api/client';

interface Props {
  eventId: string;
  event: Event;
  initialBase64: string;
  suggestedAk?: string; // z.B. aus dem Kommuniqué-Dokument selbst erkannt
  onDone: () => void;
  onClose: () => void;
}

interface DetectedTeam { number: number; name: string; club?: string | null; lv?: string | null }
interface DetectedAK { name: string; shortName: string; teams: DetectedTeam[] }

type Step = 'analyzing' | 'pick-race' | 'applying' | 'done';

const RACE_KIND_OPTIONS: Array<{ key: string; label: string; type: RaceType; format: 'INDIVIDUAL' | 'TEAM_PAIRS' }> = [
  { key: 'punktefahren', label: 'Punktefahren', type: 'PUNKTEFAHREN', format: 'INDIVIDUAL' },
  { key: 'temporunden',  label: 'Temporunden',  type: 'TEMPORUNDEN',  format: 'INDIVIDUAL' },
  { key: 'madison',      label: 'Madison',      type: 'PUNKTEFAHREN', format: 'TEAM_PAIRS' },
];

const RACE_TYPE_LABEL: Record<RaceType, string> = {
  PUNKTEFAHREN: 'Punktefahren',
  TEMPORUNDEN: 'Temporunden',
  VERFOLGUNGSRENNEN: 'Verfolgungsrennen',
};

interface PickableRace {
  id: string;
  label: string; // "U17m · Punktefahren" o.ä.
  type: RaceType;
}

/**
 * Importiert eine Renn-Ansetzung (Communiqué-PDF) und legt fest, wer in EINEM
 * bestimmten Rennen startet. Falls das Rennen noch nicht existiert, wird es
 * gleich mit angelegt ("halbautomatisch") — die Ansetzung *ist* dann direkt
 * die Startliste, es muss also nichts vorher manuell vorbereitet werden.
 */
export default function AnsetzungImport({ eventId, event, initialBase64, suggestedAk, onDone, onClose }: Props) {
  const [step, setStep] = useState<Step>('analyzing');
  const [error, setError] = useState('');
  const [detectedTeams, setDetectedTeams] = useState<DetectedTeam[]>([]);

  // Auswahl: bestehendes Rennen ODER neues Rennen anlegen
  const [selectedRaceId, setSelectedRaceId] = useState('');
  const [creatingNew, setCreatingNew] = useState(false);
  const [newAk, setNewAk] = useState(suggestedAk ?? '');
  const [newKind, setNewKind] = useState(RACE_KIND_OPTIONS[0].key);
  const [newRaceName, setNewRaceName] = useState('');

  const [result, setResult] = useState<
    | { mode: 'legacy'; excluded: number; included: number; unmatched: number }
    | { mode: 'direct'; created: number; removed: number }
    | null
  >(null);

  // Alle wählbaren Rennen: alte (mit Kategorie) + neue (direkt am Event) zusammen
  const pickableRaces: PickableRace[] = [
    ...event.categories.flatMap(cat =>
      (cat.races ?? []).map(r => ({ id: r.id, label: `${cat.name} · ${r.name}`, type: r.type }))
    ),
    ...(event.races ?? []).map(r => ({ id: r.id, label: `${r.ak ? r.ak + ' · ' : ''}${r.name}`, type: r.type })),
  ];

  useEffect(() => {
    analyze();
    if (!newRaceName) {
      const kind = RACE_KIND_OPTIONS.find(k => k.key === newKind);
      if (kind) setNewRaceName(kind.label);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function analyze() {
    setStep('analyzing'); setError('');
    try {
      const res = await api.post<{ ageClasses: DetectedAK[] }>(
        `/api/events/${eventId}/analyze-startlist`,
        { pdfBase64: initialBase64 },
      );
      const teams = res.ageClasses.flatMap(ak => ak.teams);
      setDetectedTeams(teams);
      setStep('pick-race');
    } catch (e: any) {
      setError(e.message ?? 'Analyse fehlgeschlagen');
    }
  }

  async function apply() {
    setStep('applying'); setError('');
    try {
      let raceId = selectedRaceId;

      if (creatingNew) {
        if (!newRaceName.trim()) {
          setError('Bitte einen Namen für das neue Rennen angeben.');
          setStep('pick-race');
          return;
        }
        const kind = RACE_KIND_OPTIONS.find(k => k.key === newKind)!;
        const race = await api.post<{ id: string }>('/api/races', {
          eventId,
          ak: newAk.trim() || undefined,
          type: kind.type,
          format: kind.format,
          name: newRaceName.trim(),
          order: (event.races ?? []).length,
        });
        raceId = race.id;
      }

      if (!raceId) {
        setError('Bitte ein Rennen auswählen oder ein neues anlegen.');
        setStep('pick-race');
        return;
      }

      const res = await api.post<
        | { mode: 'legacy'; excluded: number; included: number; unmatched: number }
        | { mode: 'direct'; created: number; removed: number }
      >(`/api/races/${raceId}/apply-ansetzung`, { teams: detectedTeams });
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
          <h3 style={{ margin: 0 }}>🏁 Ansetzung importieren</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        {error && <div className="alert alert-error mb-3">{error}</div>}

        {step === 'analyzing' && (
          <div className="loading" style={{ padding: '30px 0' }}>
            <span className="spinner" /> Analysiere Ansetzung mit KI…
          </div>
        )}

        {(step === 'pick-race' || step === 'applying') && (
          <>
            <p className="text-sm text-muted" style={{ marginTop: 0 }}>
              {detectedTeams.length} Team(s) erkannt. Für welches Rennen gilt diese Ansetzung?
            </p>

            {!creatingNew && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
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
                      name="race-pick"
                      checked={selectedRaceId === race.id}
                      onChange={() => setSelectedRaceId(race.id)}
                    />
                    <span style={{ fontSize: 13 }}>
                      <strong>{race.label}</strong> <span className="text-muted">({RACE_TYPE_LABEL[race.type]})</span>
                    </span>
                  </label>
                ))}
                {pickableRaces.length === 0 && (
                  <p className="text-sm text-muted">Noch keine Rennen angelegt.</p>
                )}
              </div>
            )}

            <button
              className="btn btn-ghost btn-sm"
              style={{ paddingLeft: 0 }}
              onClick={() => { setCreatingNew(!creatingNew); setSelectedRaceId(''); }}
            >
              {creatingNew ? '← Bestehendes Rennen wählen' : '+ Neues Rennen anlegen'}
            </button>

            {creatingNew && (
              <div className="card mt-2" style={{ borderColor: '#bfdbfe', background: '#f0f7ff' }}>
                <div className="form-group">
                  <label className="form-label">Altersklasse <span className="text-muted text-sm">(nur Tag, zum Suchen/Filtern)</span></label>
                  <input
                    className="form-input"
                    value={newAk}
                    onChange={e => setNewAk(e.target.value)}
                    placeholder="z.B. U17m"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Renntyp</label>
                  <select
                    className="form-select"
                    value={newKind}
                    onChange={e => {
                      setNewKind(e.target.value);
                      const kind = RACE_KIND_OPTIONS.find(k => k.key === e.target.value);
                      if (kind) setNewRaceName(kind.label);
                    }}
                  >
                    {RACE_KIND_OPTIONS.map(k => (
                      <option key={k.key} value={k.key}>{k.label}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">Name</label>
                  <input
                    className="form-input"
                    value={newRaceName}
                    onChange={e => setNewRaceName(e.target.value)}
                    placeholder="z.B. Punktefahren Finale"
                  />
                </div>
              </div>
            )}

            <button
              className="btn btn-primary btn-block mt-3"
              onClick={apply}
              disabled={step === 'applying' || (!creatingNew && !selectedRaceId) || (creatingNew && !newRaceName.trim())}
            >
              {step === 'applying' ? 'Wende an…' : 'Ansetzung anwenden'}
            </button>
          </>
        )}

        {step === 'done' && result && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <p style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>✅ Ansetzung angewendet</p>
            <p className="text-sm text-muted" style={{ marginBottom: 20 }}>
              {result.mode === 'legacy'
                ? <>{result.included} Team(s) starten · {result.excluded} für dieses Rennen ausgeblendet
                    {result.unmatched > 0 && ` · ${result.unmatched} Startnummer(n) nicht zugeordnet`}</>
                : <>{result.created} Team(s) in der Startliste{result.removed > 0 && ` · ${result.removed} entfernt (Korrektur)`}</>
              }
            </p>
            <button className="btn btn-primary btn-block" onClick={onDone}>Fertig</button>
          </div>
        )}
      </div>
    </div>
  );
}
