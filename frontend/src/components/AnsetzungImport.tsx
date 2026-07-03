import { useEffect, useState } from 'react';
import { api, type Event, type RaceType } from '../api/client';

interface Props {
  eventId: string;
  event: Event;
  initialBase64: string;
  onDone: () => void;
  onClose: () => void;
}

interface DetectedTeam { number: number; name: string; club?: string }
interface DetectedAK { name: string; shortName: string; teams: DetectedTeam[] }

type Step = 'analyzing' | 'pick-race' | 'applying' | 'done';

const RACE_TYPE_LABEL: Record<RaceType, string> = {
  PUNKTEFAHREN: 'Punktefahren',
  TEMPORUNDEN: 'Temporunden',
  VERFOLGUNGSRENNEN: 'Verfolgungsrennen',
};

/**
 * Importiert eine Renn-Ansetzung (Communiqué-PDF) und legt fest, wer in EINEM
 * bestimmten Rennen startet. Falls das Rennen noch nicht existiert, wird es
 * bei Bedarf gleich mit angelegt ("halbautomatisch") — es muss also nicht
 * vorher manuell jedes Rennen erstellt werden.
 */
export default function AnsetzungImport({ eventId, event, initialBase64, onDone, onClose }: Props) {
  const [step, setStep] = useState<Step>('analyzing');
  const [error, setError] = useState('');
  const [detectedTeams, setDetectedTeams] = useState<DetectedTeam[]>([]);

  // Auswahl: bestehendes Rennen ODER neues Rennen anlegen
  const [selectedRaceId, setSelectedRaceId] = useState('');
  const [creatingNew, setCreatingNew] = useState(false);
  const [newCategoryId, setNewCategoryId] = useState('');
  const [newRaceType, setNewRaceType] = useState<RaceType>('PUNKTEFAHREN');
  const [newRaceName, setNewRaceName] = useState('');

  const [result, setResult] = useState<{ excluded: number; included: number; unmatched: number } | null>(null);

  useEffect(() => {
    analyze();
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
      if (event.categories.length > 0 && !creatingNew) {
        // sinnvolle Vorbelegung fürs "neues Rennen"-Formular
        setNewCategoryId(event.categories[0].id);
      }
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
        if (!newCategoryId || !newRaceName.trim()) {
          setError('Kategorie und Name für das neue Rennen angeben.');
          setStep('pick-race');
          return;
        }
        const category = event.categories.find(c => c.id === newCategoryId);
        const race = await api.post<{ id: string }>('/api/races', {
          categoryId: newCategoryId,
          type: newRaceType,
          format: category?.format ?? 'INDIVIDUAL',
          name: newRaceName.trim(),
          order: category?.races?.length ?? 0,
        });
        raceId = race.id;
      }

      if (!raceId) {
        setError('Bitte ein Rennen auswählen oder ein neues anlegen.');
        setStep('pick-race');
        return;
      }

      const numbers = detectedTeams.map(t => t.number);
      const res = await api.post<{ excluded: number; included: number; unmatched: number }>(
        `/api/races/${raceId}/apply-ansetzung`,
        { teamNumbers: numbers },
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

            {event.categories.length === 0 ? (
              <div className="alert alert-error">
                Noch keine Kategorien vorhanden — importiert zuerst die Meldeliste, bevor ihr Ansetzungen zuordnen könnt.
              </div>
            ) : (
              <>
                {!creatingNew && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                    {event.categories.flatMap(cat =>
                      (cat.races ?? []).map(race => (
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
                            <strong>{cat.name}</strong> · {race.name} ({RACE_TYPE_LABEL[race.type]})
                          </span>
                        </label>
                      ))
                    )}
                    {event.categories.every(c => (c.races ?? []).length === 0) && (
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
                      <label className="form-label">Kategorie</label>
                      <select
                        className="form-select"
                        value={newCategoryId}
                        onChange={e => setNewCategoryId(e.target.value)}
                      >
                        {event.categories.map(c => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label">Renntyp</label>
                      <select
                        className="form-select"
                        value={newRaceType}
                        onChange={e => setNewRaceType(e.target.value as RaceType)}
                      >
                        <option value="PUNKTEFAHREN">Punktefahren</option>
                        <option value="TEMPORUNDEN">Temporunden</option>
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
          </>
        )}

        {step === 'done' && result && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <p style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>✅ Ansetzung angewendet</p>
            <p className="text-sm text-muted" style={{ marginBottom: 20 }}>
              {result.included} Team(s) starten · {result.excluded} für dieses Rennen ausgeblendet
              {result.unmatched > 0 && ` · ${result.unmatched} Startnummer(n) nicht zugeordnet`}
            </p>
            <button className="btn btn-primary btn-block" onClick={onDone}>Fertig</button>
          </div>
        )}
      </div>
    </div>
  );
}
