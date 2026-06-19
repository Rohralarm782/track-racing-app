import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAdmin } from '../components/Layout';
import VerfolgungsplanungView, { PlanSaveData, fmtTime } from '../components/VerfolgungsplanungView';

// ── Typen ──────────────────────────────────────────────────────────────────────
interface SavedPlan {
  id: string;
  trackM: number;
  numRounds: number;
  anfahrtSec: number;
  lapSec: number;
  totalSec: number;
  selectedKb: number | null;
  selectedRz: number | null;
  notes: string | null;
  createdAt: string;
}

const DEFAULT_CIRC_MM = 2100;

function rollout(kb: number, rz: number): number {
  return (kb / rz) * (DEFAULT_CIRC_MM / 1000);
}
function cadenceFromPlan(plan: SavedPlan): number {
  const speedMs = plan.trackM / plan.lapSec;
  const dev = (plan.selectedKb! / plan.selectedRz!) * (DEFAULT_CIRC_MM / 1000);
  return (speedMs / dev) * 60;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', {
    weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── Rundenplan aus gespeichertem Plan ─────────────────────────────────────────
function buildLapPlan(plan: SavedPlan): Array<{ rnd: number; zeit: number; gesamt: number }> {
  const rows = [];
  let cumul = 0;
  for (let i = 1; i <= plan.numRounds; i++) {
    const t = i === 1 ? plan.anfahrtSec : plan.lapSec;
    cumul += t;
    rows.push({ rnd: i, zeit: t, gesamt: cumul });
  }
  return rows;
}

// ── Gespeicherter Plan Card ───────────────────────────────────────────────────
function SavedPlanCard({
  plan,
  isAdmin,
  onDelete,
}: {
  plan: SavedPlan;
  isAdmin: boolean;
  onDelete: () => void;
}) {
  const lapPlan = buildLapPlan(plan);
  const hasGear = plan.selectedKb !== null && plan.selectedRz !== null;
  const ro  = hasGear ? rollout(plan.selectedKb!, plan.selectedRz!) : null;
  const cad = hasGear ? cadenceFromPlan(plan) : null;

  return (
    <div
      className="card mb-4"
      style={{ border: '2px solid var(--c-primary)', background: '#f8fbff' }}
    >
      {/* Header */}
      <div className="flex-between" style={{ marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--c-primary)', textTransform: 'uppercase', marginBottom: 4 }}>
            Gespeicherter Plan
          </div>
          <div style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>
            {formatDate(plan.createdAt)}
          </div>
        </div>
        {isAdmin && (
          <button
            className="btn btn-ghost btn-sm"
            style={{ color: 'var(--c-danger)', fontSize: 12 }}
            onClick={onDelete}
          >
            Plan löschen
          </button>
        )}
      </div>

      {/* Schlüssel-Metriken */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginBottom: 2 }}>Zielzeit</div>
          <div style={{ fontWeight: 800, fontSize: 22, letterSpacing: '-0.5px' }}>{fmtTime(plan.totalSec)}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginBottom: 2 }}>Rundenzeit rd. 2+</div>
          <div style={{ fontWeight: 700, fontSize: 20 }}>{plan.lapSec.toFixed(2)}s</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginBottom: 2 }}>Distanz</div>
          <div style={{ fontWeight: 700, fontSize: 20 }}>{plan.numRounds} × {plan.trackM}m</div>
        </div>
      </div>

      {/* Gewählter Gang – großes Display */}
      {hasGear ? (
        <div
          style={{
            background: 'var(--c-primary)',
            borderRadius: 10,
            padding: '16px 20px',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 24,
          }}
        >
          <div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.75)', fontWeight: 600, marginBottom: 4, letterSpacing: '0.05em' }}>
              GANG
            </div>
            <div style={{ fontWeight: 900, fontSize: 36, color: 'white', letterSpacing: '-1px', lineHeight: 1 }}>
              {plan.selectedKb} / {plan.selectedRz}
            </div>
          </div>
          <div style={{ borderLeft: '1px solid rgba(255,255,255,0.3)', paddingLeft: 20 }}>
            <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 14, marginBottom: 6 }}>
              Rollout: <strong style={{ color: 'white' }}>{ro!.toFixed(2)} m</strong>
            </div>
            <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 14 }}>
              Trittfrequenz: <strong style={{ color: 'white' }}>{cad!.toFixed(0)} rpm</strong>
            </div>
          </div>
        </div>
      ) : (
        <div className="alert" style={{ marginBottom: 16, fontSize: 13, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e' }}>
          Kein Gang in diesem Plan festgelegt
        </div>
      )}

      {/* Rundenplan */}
      <div style={{ fontSize: 12, color: 'var(--c-text-muted)', marginBottom: 6 }}>Rundenplan</div>
      <div style={{ maxHeight: 260, overflowY: 'auto', borderRadius: 8, border: '1px solid var(--c-border)' }}>
        <table className="table" style={{ fontSize: 13, margin: 0 }}>
          <thead>
            <tr>
              <th style={{ width: 44 }}>Rd.</th>
              <th>Zeit</th>
              <th>Gesamt</th>
            </tr>
          </thead>
          <tbody>
            {lapPlan.map(lap => (
              <tr key={lap.rnd} style={{ background: lap.rnd === plan.numRounds ? '#f0fff4' : '' }}>
                <td style={{ color: 'var(--c-text-muted)', fontWeight: lap.rnd === plan.numRounds ? 700 : 400 }}>{lap.rnd}</td>
                <td style={{ fontWeight: lap.rnd > 1 ? 600 : 400, color: lap.rnd === 1 ? 'var(--c-text-muted)' : '' }}>
                  {fmtTime(lap.zeit)}
                </td>
                <td style={{ fontWeight: lap.rnd === plan.numRounds ? 700 : 400 }}>{fmtTime(lap.gesamt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Hauptseite ────────────────────────────────────────────────────────────────
export default function PursuitPage() {
  const { isAdmin } = useAdmin();
  const [savedPlan, setSavedPlan]     = useState<SavedPlan | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(true);
  const [error, setError]             = useState('');

  useEffect(() => { loadPlan(); }, []);

  async function loadPlan() {
    try {
      const plan = await api.get<SavedPlan | null>('/api/pursuit-plans/latest');
      setSavedPlan(plan ?? null);
    } catch {
      // Kein Plan vorhanden – kein Fehler für den User
    } finally {
      setLoadingPlan(false);
    }
  }

  async function handleSave(data: PlanSaveData) {
    setError('');
    const plan = await api.post<SavedPlan>('/api/pursuit-plans', data);
    setSavedPlan(plan);
  }

  async function handleDelete() {
    if (!savedPlan || !confirm('Gespeicherten Plan löschen?')) return;
    try {
      await api.delete(`/api/pursuit-plans/${savedPlan.id}`);
      setSavedPlan(null);
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div className="page container">
      <div className="flex-between mb-4">
        <div>
          <h1>Verfolgungsplanung</h1>
          <p className="text-sm text-muted" style={{ margin: '2px 0 0' }}>
            Gangplanung und Schrittmacherrechner
          </p>
        </div>
      </div>

      {error && <div className="alert alert-error mb-3">{error}</div>}

      {/* Gespeicherter Plan — für alle sichtbar */}
      {!loadingPlan && savedPlan && (
        <SavedPlanCard plan={savedPlan} isAdmin={isAdmin} onDelete={handleDelete} />
      )}

      {!loadingPlan && !savedPlan && !isAdmin && (
        <div className="alert alert-info mb-4" style={{ fontSize: 13 }}>
          Noch kein Plan gespeichert – der Trainer kann den Rechner unten verwenden und einen Plan speichern.
        </div>
      )}

      {/* Trennlinie wenn Plan vorhanden */}
      {savedPlan && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <div style={{ flex: 1, height: 1, background: 'var(--c-border)' }} />
          <span style={{ fontSize: 12, color: 'var(--c-text-muted)', whiteSpace: 'nowrap' }}>
            {isAdmin ? 'Neuen Plan erstellen' : 'Rechner (lokal, ohne Speichern)'}
          </span>
          <div style={{ flex: 1, height: 1, background: 'var(--c-border)' }} />
        </div>
      )}

      {/* Rechner — für alle nutzbar */}
      <VerfolgungsplanungView isAdmin={isAdmin} onSave={isAdmin ? handleSave : undefined} />
    </div>
  );
}
