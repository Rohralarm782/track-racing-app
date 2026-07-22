// Gemeinsames PIN-Pad für den Kiosk-Modus.
//
// Aus KioskShell herausgelöst, damit dieselbe Komponente und dieselben
// PIN-Helfer sowohl fürs Beenden des Kiosk (KioskShell) als auch fürs
// Entsperren der Bearbeitung im Kiosk genutzt werden — ein PIN, eine
// Implementierung, kein zweites System.
import { useEffect, useState } from 'react';

// ── PIN-Speicher (nur auf diesem Gerät) ─────────────────────────────────────
export const PIN_KEY = 'kiosk_exit_pin';
export const PIN_LEN = 4;
export const getStoredPin = () => localStorage.getItem(PIN_KEY);
export const setStoredPin = (pin: string) => localStorage.setItem(PIN_KEY, pin);
export const clearStoredPin = () => localStorage.removeItem(PIN_KEY);

// ── PIN-Pad ─────────────────────────────────────────────────────────────────
export default function PinPad({ title, subtitle, error, onSubmit, onCancel, forgot }: {
  title: string; subtitle: string; error?: string;
  onSubmit: (code: string) => void; onCancel: () => void; forgot?: () => void;
}) {
  const [buf, setBuf] = useState('');
  useEffect(() => { if (error) setBuf(''); }, [error]);
  const press = (d: string) => {
    if (buf.length >= PIN_LEN) return;
    const next = buf + d;
    setBuf(next);
    if (next.length === PIN_LEN) setTimeout(() => onSubmit(next), 120);
  };
  const keyStyle: React.CSSProperties = {
    padding: '18px 0', fontSize: 24, fontWeight: 600, borderRadius: 12,
    border: '1px solid var(--c-border)', background: 'var(--c-white)', cursor: 'pointer', fontFamily: 'inherit',
  };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.6)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: 'var(--c-white)', borderRadius: 16, padding: 28, width: 340, textAlign: 'center',
        boxShadow: '0 20px 50px rgba(0,0,0,.35)' }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 19 }}>{title}</h3>
        <p style={{ margin: '0 0 16px', fontSize: 13.5, color: 'var(--c-text-muted)' }}>{subtitle}</p>
        <div style={{ color: 'var(--c-danger)', fontSize: 13, fontWeight: 600, height: 18, marginBottom: 6 }}>
          {error ?? ''}
        </div>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginBottom: 20, height: 16 }}>
          {Array.from({ length: PIN_LEN }).map((_, i) => (
            <div key={i} style={{ width: 15, height: 15, borderRadius: '50%',
              border: '2px solid ' + (i < buf.length ? 'var(--c-primary)' : 'var(--c-border)'),
              background: i < buf.length ? 'var(--c-primary)' : 'transparent' }} />
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
          {['1','2','3','4','5','6','7','8','9'].map(d => (
            <button key={d} style={keyStyle} onClick={() => press(d)}>{d}</button>
          ))}
          <button style={{ ...keyStyle, fontSize: 16 }} onClick={onCancel}>✕</button>
          <button style={keyStyle} onClick={() => press('0')}>0</button>
          <button style={{ ...keyStyle, fontSize: 18 }} onClick={() => setBuf(buf.slice(0, -1))}>⌫</button>
        </div>
        {forgot && (
          <button onClick={forgot} style={{ marginTop: 14, fontSize: 13, color: 'var(--c-primary)',
            background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer' }}>
            PIN vergessen? Mit Admin-Passwort entsperren
          </button>
        )}
      </div>
    </div>
  );
}
