import { useRef, useState } from 'react';
import { api } from '../api/client';

// ── Typen ──────────────────────────────────────────────────────────────────────
interface AKTeam {
  number: number; name: string; club: string | null; lv?: string | null;
  rider2?: string | null; rider2Club?: string | null; rider2Lv?: string | null;
}
interface DetectedAK { name: string; shortName: string; teams: AKTeam[]; }

interface Group {
  id: string;
  catName: string;
  included: boolean;
  teams: AKTeam[];
  sourceNames: string[]; // originale AK-Namen (z.B. ["U15m", "U17w"])
}

interface Props {
  eventId: string;
  onDone: () => void;   // reload event after import
  onClose: () => void;
}

type Step = 'upload' | 'preview' | 'applying';

let _gid = 0;
const gid = () => String(++_gid);

// ── Komponente ─────────────────────────────────────────────────────────────────
export default function StartlistImport({ eventId, onDone, onClose }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep]       = useState<Step>('upload');
  const [groups, setGroups]   = useState<Group[]>([]);
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);

  // Merge-Auswahl
  const [mergeMode, setMergeMode]   = useState(false);
  const [mergeIds, setMergeIds]     = useState<Set<string>>(new Set());
  const [mergeName, setMergeName]   = useState('');

  // ── Schritt 1: PDF hochladen & analysieren ────────────────────────────────
  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true); setError('');
    try {
      const base64 = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload  = () => res((r.result as string).split(',')[1]);
        r.onerror = () => rej(new Error('Lesen fehlgeschlagen'));
        r.readAsDataURL(file);
      });
      const result = await api.post<{ ageClasses: DetectedAK[] }>(
        `/api/events/${eventId}/analyze-startlist`,
        { pdfBase64: base64 },
      );
      // Jede AK wird zu einer eigenen Gruppe
      setGroups(result.ageClasses.map(ak => ({
        id: gid(),
        catName: ak.shortName,
        included: true,
        teams: ak.teams,
        sourceNames: [ak.name],
      })));
      setStep('preview');
    } catch (e: any) {
      setError(e.message ?? 'Analyse fehlgeschlagen');
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  // ── Schritt 2: Vorschau – Gruppe umbenennen / aus-/einschließen ────────────
  function setGroupName(id: string, name: string) {
    setGroups(gs => gs.map(g => g.id === id ? { ...g, catName: name } : g));
  }
  function toggleIncluded(id: string) {
    setGroups(gs => gs.map(g => g.id === id ? { ...g, included: !g.included } : g));
  }
  function removeGroup(id: string) {
    setGroups(gs => gs.filter(g => g.id !== id));
  }

  // ── Zusammenlegen ─────────────────────────────────────────────────────────
  function enterMerge() {
    setMergeMode(true);
    setMergeIds(new Set());
    setMergeName('');
  }
  function toggleMergeId(id: string) {
    setMergeIds(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      // Kombinationsname vorschlagen
      const selGroups = groups.filter(g => n.has(g.id));
      setMergeName(selGroups.map(g => g.catName).join(' / '));
      return n;
    });
  }
  function applyMerge() {
    const toMerge = groups.filter(g => mergeIds.has(g.id));
    if (toMerge.length < 2 || !mergeName.trim()) return;
    const merged: Group = {
      id: gid(),
      catName: mergeName.trim(),
      included: true,
      teams: toMerge.flatMap(g => g.teams),
      sourceNames: toMerge.flatMap(g => g.sourceNames),
    };
    setGroups(gs => [
      ...gs.filter(g => !mergeIds.has(g.id)),
      merged,
    ]);
    setMergeMode(false);
    setMergeIds(new Set());
    setMergeName('');
  }
  function cancelMerge() {
    setMergeMode(false);
    setMergeIds(new Set());
    setMergeName('');
  }

  // ── Schritt 3: Kategorien anlegen ─────────────────────────────────────────
  async function handleApply() {
    const toCreate = groups.filter(g => g.included);
    if (toCreate.length === 0) return;
    setLoading(true); setError('');
    setStep('applying');
    try {
      await api.post(`/api/events/${eventId}/apply-startlist`, {
        groups: toCreate.map(g => ({ name: g.catName, teams: g.teams })),
      });
      onDone();
    } catch (e: any) {
      setError(e.message ?? 'Fehler beim Erstellen');
      setStep('preview');
    } finally {
      setLoading(false);
    }
  }

  const includedCount = groups.filter(g => g.included).length;
  const totalTeams    = groups.filter(g => g.included).reduce((s, g) => s + g.teams.length, 0);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 640, maxHeight: '90vh', overflowY: 'auto' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex-between" style={{ marginBottom: 16 }}>
          <p className="modal-title" style={{ margin: 0 }}>
            Gesamte Startliste importieren
          </p>
          <button
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            disabled={loading}
          >
            ✕
          </button>
        </div>

        {error && <div className="alert alert-error mb-3">{error}</div>}

        {/* ── Upload ── */}
        {step === 'upload' && (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            {loading ? (
              <>
                <div className="loading" style={{ justifyContent: 'center', marginBottom: 8 }}>
                  <span className="spinner" />
                </div>
                <p className="text-muted text-sm">Analysiere Startliste mit KI…</p>
              </>
            ) : (
              <>
                <p style={{ marginBottom: 16, color: 'var(--c-text-muted)', fontSize: 13 }}>
                  Vollständige Meldeliste (PDF) mit allen Altersklassen hochladen.
                  Die KI erkennt automatisch alle AKs und Teilnehmer.
                </p>
                <label style={{ cursor: 'pointer' }}>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".pdf"
                    style={{ display: 'none' }}
                    onChange={handleFile}
                  />
                  <span className="btn btn-primary" style={{ pointerEvents: 'none' }}>
                    📄 PDF auswählen
                  </span>
                </label>
              </>
            )}
          </div>
        )}

        {/* ── Vorschau ── */}
        {step === 'preview' && (
          <>
            {/* Merge-Modus */}
            {mergeMode ? (
              <div
                className="card mb-4"
                style={{ background: '#fffbeb', border: '1px solid #fde68a', padding: '14px 16px' }}
              >
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
                  AKs für Zusammenlegung auswählen (mind. 2):
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                  {groups.map(g => (
                    <label
                      key={g.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}
                    >
                      <input
                        type="checkbox"
                        checked={mergeIds.has(g.id)}
                        onChange={() => toggleMergeId(g.id)}
                      />
                      <span style={{ fontWeight: 500 }}>{g.catName}</span>
                      <span className="text-muted">({g.teams.length} Starter)</span>
                      {g.sourceNames.length > 1 && (
                        <span className="badge badge-blue" style={{ fontSize: 10 }}>
                          zusammengelegt
                        </span>
                      )}
                    </label>
                  ))}
                </div>
                <div className="form-group" style={{ marginBottom: 12 }}>
                  <label className="form-label">Kategoriename für die zusammengelegte Gruppe:</label>
                  <input
                    className="form-input"
                    value={mergeName}
                    onChange={e => setMergeName(e.target.value)}
                    placeholder="z.B. U15m / U17w"
                    autoFocus
                  />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost btn-sm" onClick={cancelMerge}>Abbrechen</button>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={applyMerge}
                    disabled={mergeIds.size < 2 || !mergeName.trim()}
                  >
                    Zusammenlegen ({mergeIds.size} AKs)
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex-between mb-3">
                <span className="text-sm text-muted">
                  {groups.length} AK{groups.length !== 1 ? 's' : ''} erkannt
                </span>
                {groups.length >= 2 && (
                  <button className="btn btn-secondary btn-sm" onClick={enterMerge}>
                    AKs zusammenlegen
                  </button>
                )}
              </div>
            )}

            {/* Gruppen-Liste */}
            {!mergeMode && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                {groups.map(g => (
                  <div
                    key={g.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '10px 12px',
                      border: `1px solid ${g.included ? 'var(--c-border)' : '#e5e7eb'}`,
                      borderRadius: 8,
                      background: g.included ? 'white' : '#f9fafb',
                      opacity: g.included ? 1 : 0.6,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={g.included}
                      onChange={() => toggleIncluded(g.id)}
                      style={{ flexShrink: 0 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        {g.sourceNames.length > 1 && (
                          <span className="badge badge-blue" style={{ fontSize: 10 }}>
                            {g.sourceNames.join(' + ')}
                          </span>
                        )}
                        <span className="text-xs text-muted">
                          {g.teams.length} {g.teams.some(t => t.rider2) ? 'Team(s)' : 'Starter'}
                        </span>
                        {g.teams.some(t => t.rider2) && (
                          <span className="badge badge-blue" style={{ fontSize: 10 }}>👥 Paare</span>
                        )}
                        {g.teams.some(t => t.lv === 'MEV' || t.rider2Lv === 'MEV') && (
                          <span className="badge badge-green" style={{ fontSize: 10 }}>
                            ⭐ {g.teams.filter(t => t.lv === 'MEV' || t.rider2Lv === 'MEV').length} MEV
                          </span>
                        )}
                      </div>
                      <input
                        className="form-input"
                        value={g.catName}
                        onChange={e => setGroupName(g.id, e.target.value)}
                        disabled={!g.included}
                        style={{ fontSize: 13, padding: '5px 8px', height: 'auto' }}
                        placeholder="Kategoriename"
                      />
                    </div>
                    <button
                      onClick={() => removeGroup(g.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-muted)', fontSize: 16, padding: '4px 6px', flexShrink: 0 }}
                      title="Entfernen"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            {!mergeMode && (
              <div className="flex-between">
                <button className="btn btn-ghost" onClick={onClose}>Abbrechen</button>
                <button
                  className="btn btn-primary"
                  onClick={handleApply}
                  disabled={includedCount === 0}
                >
                  {includedCount} Kategorie{includedCount !== 1 ? 'n' : ''} erstellen
                  {totalTeams > 0 && ` (${totalTeams} Starter)`}
                </button>
              </div>
            )}
          </>
        )}

        {/* ── Anwenden ── */}
        {step === 'applying' && (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div className="loading" style={{ justifyContent: 'center', marginBottom: 8 }}>
              <span className="spinner" />
            </div>
            <p className="text-muted text-sm">Kategorien und Teams werden angelegt…</p>
          </div>
        )}
      </div>
    </div>
  );
}
