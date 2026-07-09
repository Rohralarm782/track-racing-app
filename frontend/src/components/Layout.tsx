import { createContext, useCallback, useContext, useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { api, clearToken, getToken, setToken } from '../api/client';

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

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function Layout() {
  const [token, setTokenState] = useState<string | null>(getToken);
  const [showLogin, setShowLogin] = useState(false);
  const [password, setPassword]  = useState('');
  const [loading, setLoading]    = useState(false);
  const [error, setError]        = useState('');
  const navigate = useNavigate();

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
      {/* ── Header ── */}
      <header className="header">
        <div className="header-inner">
          <Link to="/" className="header-brand">🚴 Bahnrad-Tracker</Link>
          <Link to="/pursuit" className="btn btn-ghost btn-sm">Verfolgung</Link>
          <Link to="/athletes" className="btn btn-ghost btn-sm">Sportler</Link>
          {token && <Link to="/settings" className="btn btn-ghost btn-sm">⚙️ Einstellungen</Link>}
          <div className="flex-center gap-2">
            {token ? (
              <>
                <span className="badge badge-green">Admin</span>
                <button className="btn btn-secondary btn-sm" onClick={logout}>Abmelden</button>
              </>
            ) : (
              <button className="btn btn-secondary btn-sm" onClick={() => setShowLogin(true)}>
                Admin
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ── Login Modal ── */}
      {showLogin && (
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
    </AdminContext.Provider>
  );
}
