import { createContext, useCallback, useContext, useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { api, clearToken, getToken, setToken } from '../api/client';
import KioskShell from './KioskShell';

// ─── Admin Context ────────────────────────────────────────────────────────────

interface AdminCtx {
  isAdmin: boolean;
  token: string | null;
  logout: () => void;
  openLogin: () => void;
}

const AdminContext = createContext<AdminCtx>({
  isAdmin: false, token: null, logout: () => {}, openLogin: () => {},
});

export function useAdmin() {
  return useContext(AdminContext);
}

// ─── Kiosk Context ──────────────────────────────────────────────────────────
// Der Kiosk-Modus ist ein Layout-weiter Zustand: Ist er aktiv, wird der normale
// App-Header durch die gesperrte KioskShell ersetzt, während der Seiteninhalt
// (Zeitplan/Kommuniqués mit allen Funktionen) unverändert bleibt. Seiten starten
// ihn über useKiosk().startKiosk(eventId) — siehe KioskButton.

interface KioskCtx {
  active: boolean;
  startKiosk: (eventId: string) => void;
}

const KioskContext = createContext<KioskCtx>({ active: false, startKiosk: () => {} });

export function useKiosk() {
  return useContext(KioskContext);
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function Layout() {
  const [token, setTokenState] = useState<string | null>(getToken);
  const [showLogin, setShowLogin] = useState(false);
  const [password, setPassword]  = useState('');
  const [loading, setLoading]    = useState(false);
  const [error, setError]        = useState('');
  const navigate = useNavigate();

  // Kiosk-Modus: aktiv für genau eine Veranstaltung. In sessionStorage gehalten,
  // damit ein versehentlicher Reload den gesperrten Zustand nicht aufhebt
  // (Vollbild geht beim Reload verloren → KioskShell zeigt dann „Wieder Vollbild").
  const [kioskEventId, setKioskEventId] = useState<string | null>(
    () => sessionStorage.getItem('kiosk_active_event'));

  const startKiosk = useCallback((eventId: string) => {
    sessionStorage.setItem('kiosk_active_event', eventId);
    setKioskEventId(eventId);
    // Direkt im Klick (User-Geste) darf Vollbild angefordert werden.
    document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);

  const stopKiosk = useCallback(() => {
    sessionStorage.removeItem('kiosk_active_event');
    setKioskEventId(null);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setTokenState(null);
  }, []);

  const handleLogin = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    setError('');
    const ok = await api.verifyAdmin(password);
    setLoading(false);
    if (ok) {
      setToken(password);
      setTokenState(password);
      setShowLogin(false);
      setPassword('');
    } else {
      setError('Passwort falsch');
    }
  }, [password]);

  return (
    <AdminContext.Provider value={{ isAdmin: !!token, token, logout, openLogin: () => setShowLogin(true) }}>
    <KioskContext.Provider value={{ active: kioskEventId != null, startKiosk }}>
      {kioskEventId ? (
        /* ── Kiosk-Kopfleiste statt Header ── */
        <KioskShell eventId={kioskEventId} onExit={stopKiosk} />
      ) : (
      /* ── Header ── */
      <header className="header">
        <div className="header-inner">
          <Link to="/" className="header-brand" aria-label="Startseite">
            <span>🚴</span>
            <span className="brand-text">Bahnrad-Tracker</span>
          </Link>
          <nav className="header-nav">
            <Link to="/pursuit" className="btn btn-ghost btn-sm" title="Verfolgung">
              <span>⏱</span><span className="nav-text">Verfolgung</span>
            </Link>
            <Link to="/athletes" className="btn btn-ghost btn-sm" title="Sportler">
              <span>👤</span><span className="nav-text">Sportler</span>
            </Link>
            {token && (
              <Link to="/settings" className="btn btn-ghost btn-sm" title="Einstellungen">
                <span>⚙️</span><span className="nav-text">Einstellungen</span>
              </Link>
            )}
            {token ? (
              <button className="btn btn-secondary btn-sm" onClick={logout} title="Abmelden">
                <span>🚪</span><span className="nav-text">Abmelden</span>
              </button>
            ) : (
              <button className="btn btn-secondary btn-sm" onClick={() => setShowLogin(true)}>
                Admin
              </button>
            )}
          </nav>
        </div>
      </header>
      )}

      {/* ── Login Modal (im Kiosk-Modus unterdrückt) ── */}
      {!kioskEventId && showLogin && (
        <div className="modal-overlay" onClick={() => setShowLogin(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <p className="modal-title">Admin-Login</p>
            {error && <div className="alert alert-error">{error}</div>}
            <div className="form-group">
              <label className="form-label">Passwort</label>
              <input
                type="password"
                className="form-input"
                value={password}
                autoFocus
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                placeholder="Admin-Passwort eingeben"
              />
            </div>
            <div className="flex-between">
              <button className="btn btn-ghost" onClick={() => { setShowLogin(false); setPassword(''); setError(''); }}>
                Abbrechen
              </button>
              <button className="btn btn-primary" onClick={handleLogin} disabled={loading || !password}>
                {loading ? 'Prüfe…' : 'Anmelden'}
              </button>
            </div>
          </div>
        </div>
      )}

      <main>
        <Outlet />
      </main>
    </KioskContext.Provider>
    </AdminContext.Provider>
  );
}
