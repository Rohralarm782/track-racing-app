const API_URL = import.meta.env.VITE_API_URL ?? '';

// ─── Token management ─────────────────────────────────────────────────────────

export function getToken(): string | null {
  return localStorage.getItem('admin_token');
}
export function setToken(token: string) {
  localStorage.setItem('admin_token', token);
}
export function clearToken() {
  localStorage.removeItem('admin_token');
}

// ─── Typed API types ──────────────────────────────────────────────────────────

export type CategoryFormat = 'INDIVIDUAL' | 'TEAM_PAIRS';
export type RaceType = 'PUNKTEFAHREN' | 'TEMPORUNDEN' | 'VERFOLGUNGSRENNEN';
export type RaceStatus = 'SETUP' | 'ACTIVE' | 'FINISHED';

export interface Team {
  id: string;
  categoryId: string;
  number: number;
  name: string;
  rider1?: string | null;
  rider2?: string | null;
}

export interface Category {
  id: string;
  eventId: string;
  name: string;
  format: CategoryFormat;
  event?: { id: string; name: string; date: string };
  teams?: Team[];
  races?: Race[];
  _count?: { teams: number };
}

export interface Race {
  id: string;
  name: string;
  type: RaceType;
  status: RaceStatus;
  order: number;
}

export interface Event {
  id: string;
  name: string;
  date?: string | null;

  categories: Array<Category & { _count: { teams: number }; races: Race[] }>;
}

// ─── Core fetch helper ────────────────────────────────────────────────────────

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      msg = body.error ?? JSON.stringify(body);
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as T;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const api = {
  get:    <T>(path: string)                   => request<T>(path),
  post:   <T>(path: string, body: unknown)    => request<T>(path, { method: 'POST',   body: JSON.stringify(body) }),
  patch:  <T>(path: string, body: unknown)    => request<T>(path, { method: 'PATCH',  body: JSON.stringify(body) }),
  put:    <T>(path: string, body: unknown)    => request<T>(path, { method: 'PUT',    body: JSON.stringify(body) }),
  delete: <T>(path: string)                   => request<T>(path, { method: 'DELETE' }),

  /** Verify admin password — returns true if accepted */
  async verifyAdmin(password: string): Promise<boolean> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${password}`,
      };
      const res = await fetch(`${API_URL}/api/admin/verify`, { headers });
      return res.ok;
    } catch {
      return false;
    }
  },
};
