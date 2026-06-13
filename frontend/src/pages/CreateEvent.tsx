import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';

const AGE_CLASSES = ['U15', 'U17', 'U19', 'Elite'] as const;
type AgeClass = typeof AGE_CLASSES[number];
type Selection = Record<AgeClass, { m: boolean; w: boolean }>;

const EMPTY: Selection = {
  U15: { m: false, w: false },
  U17: { m: false, w: false },
  U19: { m: false, w: false },
  Elite: { m: false, w: false },
};

export default function CreateEvent() {
  const navigate = useNavigate();
  const [name, setName]         = useState('');
  const [date, setDate]         = useState('');
  const [selected, setSelected] = useState<Selection>(EMPTY);
  const [format, setFormat]     = useState<'INDIVIDUAL' | 'TEAM_PAIRS'>('INDIVIDUAL');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  const hasAny = AGE_CLASSES.some(a => selected[a].m || selected[a].w);

  function toggle(age: AgeClass, g: 'm' | 'w') {
    setSelected(prev => ({ ...prev, [age]: { ...prev[age], [g]: !prev[age][g] } }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name) return;
    setSaving(true);
    setError('');
    try {
      const ev = await api.post<{ id: string }>('/api/events', {
        name,
        date: date ? new Date(date).toISOString() : undefined,
      });
      await Promise.all(
        AGE_CLASSES.flatMap(age =>
          (['m', 'w'] as const).flatMap(g =>
            selected[age][g]
              ? [api.post('/api/categories', { eventId: ev.id, name: `${age} ${g}`, format })]
              : []
          )
        )
      );
      navigate(`/events/${ev.id}`);
    } catch (e: any) {
      setError(e.message ?? 'Fehler');
      setSaving(false);
    }
  }

  const btn = (active: boolean): React.CSSProperties => ({
    width: 38, height: 28, borderRadius: 6, cursor: 'pointer',
    border: active ? '2px solid var(--c-primary)' : '1px solid var(--c-border)',
    background: active ? '#dbeafe' : 'var(--c-white)',
    color: active ? 'var(--c-primary)' : 'var(--c-text-muted)',
    fontWeight: 600, fontSize: 12, padding: 0,
  });

  return (
    <div className="page container" style={{ maxWidth: 480 }}>
      <div className="breadcrumb">
        <Link to="/">Veranstaltungen</Link><span>›</span>Neue Veranstaltung
      </div>
      <h1 className="mb-4">Neue Veranstaltung</h1>
      {error && <div className="alert alert-error">{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="card">
          <div className="form-group">
            <label className="form-label">Name *</label>
            <input className="form-input" type="text" value={name}
              onChange={e => setName(e.target.value)}
              placeholder="z.B. Frankfurter Frühjahrsomnium 2025"
              required autoFocus />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">
              Datum <span className="text-muted text-sm">(optional)</span>
            </label>
            <input className="form-input" type="date" value={date}
              onChange={e => setDate(e.target.value)} />
          </div>
        </div>

        <div className="card mt-3">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <h3>Altersklassen <span className="text-muted text-sm">(optional)</span></h3>
            <div style={{ display: 'flex', gap: 16 }}>
              <span style={{ width: 38, textAlign: 'center', fontSize: 11, color: 'var(--c-text-muted)', fontWeight: 500 }}>m</span>
              <span style={{ width: 38, textAlign: 'center', fontSize: 11, color: 'var(--c-text-muted)', fontWeight: 500 }}>w</span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {AGE_CLASSES.map(age => (
              <div key={age} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{age}</span>
                <div style={{ display: 'flex', gap: 16 }}>
                  {(['m', 'w'] as const).map(g => (
                    <button key={g} type="button" style={btn(selected[age][g])}
                      onClick={() => toggle(age, g)}>{g}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {hasAny && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--c-border)' }}>
              <label className="form-label">Format</label>
              <div style={{ display: 'flex', gap: 16 }}>
                {([['INDIVIDUAL', 'Einzelrennen'], ['TEAM_PAIRS', 'Madison']] as const).map(([val, label]) => (
                  <label key={val} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                    <input type="radio" name="format" value={val}
                      checked={format === val} onChange={() => setFormat(val)} />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex-between mt-4">
          <Link to="/" className="btn btn-ghost">Abbrechen</Link>
          <button type="submit" className="btn btn-primary btn-lg"
            disabled={saving || !name}>
            {saving ? 'Erstelle…' : 'Veranstaltung erstellen'}
          </button>
        </div>
      </form>
    </div>
  );
}
