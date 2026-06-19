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
  const hasGear = plan.selectedKb !== null && plan.selectedRz !== null;
  const ro  = hasGear ? rollout(plan.selectedKb!, plan.selectedRz!) : null;
  const cad = hasGear ? cadenceFromPlan(plan) : null;
  const totalDistM = Math.round(plan.numRounds * plan.trackM);

  return (
    <div
      className="card mb-4"
      style={{ border: '2px solid var(--c-primary)', background: '#f8fbff', padding: '14px 18px' }}
    >
      {/* Header: Name + Datum + Löschen */}
      <div className="flex-between" style={{ marginBottom: 10 }}>
        <div>
          {plan.notes && (
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 2 }}>{plan.notes}</div>
          )}
          <div style={{ fontSize: 11, color: 'var(--c-primary)', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            Gespeicherter Plan · {formatDate(plan.createdAt)}
          </div>
        </div>
        {isAdmin && (
          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--c-danger)', fontSize: 12 }} onClick={onDelete}>
            Löschen
          </button>
        )}
      </div>

      {/* Alle Metriken in einer Zeile */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>
          Zielzeit <strong style={{ color: 'var(--c-text)', fontSize: 15 }}>{fmtTime(plan.totalSec)}</strong>
        </span>
        <span style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>
          Rundenzeit <strong style={{ color: 'var(--c-text)', fontSize: 15 }}>{plan.lapSec.toFixed(2)}s</strong>
        </span>
        <span style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>
          {plan.numRounds} Runden · <strong style={{ color: 'var(--c-text)' }}>{totalDistM}m</strong>
        </span>
      </div>

      {/* Gang – kompaktes Display */}
      {hasGear ? (
        <div style={{
          background: 'var(--c-primary)', borderRadius: 8, padding: '10px 16px',
          display: 'flex', alignItems: 'center', gap: 20,
        }}>
          <div style={{ fontWeight: 900, fontSize: 28, color: 'white', letterSpacing: '-1px', lineHeight: 1 }}>
            {plan.selectedKb} / {plan.selectedRz}
          </div>
          <div style={{ borderLeft: '1px solid rgba(255,255,255,0.3)', paddingLeft: 16, fontSize: 13 }}>
            <div style={{ color: 'rgba(255,255,255,0.85)' }}>
              Rollout <strong style={{ color: 'white' }}>{ro!.toFixed(2)} m</strong>
            </div>
            <div style={{ color: 'rgba(255,255,255,0.85)', marginTop: 2 }}>
              <strong style={{ color: 'white' }}>{cad!.toFixed(0)} rpm</strong>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--c-text-muted)', fontStyle: 'italic' }}>Kein Gang festgelegt</div>
      )}
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
