const API_URL = import.meta.env.VITE_API_URL ?? '';

export function getToken(): string | null { return localStorage.getItem('admin_token'); }
export function setToken(token: string) { localStorage.setItem('admin_token', token); }
export function clearToken() { localStorage.removeItem('admin_token'); }

export type CategoryFormat = 'INDIVIDUAL' | 'TEAM_PAIRS';
export type RaceType = 'PUNKTEFAHREN' | 'TEMPORUNDEN' | 'VERFOLGUNGSRENNEN';
export type RaceStatus = 'SETUP' | 'ACTIVE' | 'FINISHED';

export interface Team {
  id: string;
  categoryId: string;
  number: number;
  name: string;
  club?: string | null;
  isFavorite?: boolean;
  rider1?: string | null;
  rider2?: string | null;
  color?: string | null;
  pattern?: string | null;
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

export type DocType = 'STARTLISTE' | 'ERGEBNIS' | 'SONSTIGES';

export interface CommuniqueDocument {
  id: string;
  sourceId: string;
  fileName: string;
  docType: DocType;
  ak: string;
  remoteModifiedAt: string;
  discoveredAt: string;
}

export interface CommuniqueSource {
  id: string;
  eventId: string;
  shareToken: string;
  label: string | null;
  lastPolledAt: string | null;
  documents: CommuniqueDocument[];
}

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
    try { const body = await res.json(); msg = body.error ?? JSON.stringify(body); } catch { }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as T;
}

export const api = {
  get:    <T>(path: string)                => request<T>(path),
  post:   <T>(path: string, body: unknown) => request<T>(path, { method: 'POST',   body: JSON.stringify(body) }),
  patch:  <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH',  body: JSON.stringify(body) }),
  put:    <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT',    body: JSON.stringify(body) }),
  delete: <T>(path: string)               => request<T>(path, { method: 'DELETE' }),

  async verifyAdmin(password: string): Promise<boolean> {
    try {
      const res = await fetch(`${API_URL}/api/admin/verify`, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${password}` },
      });
      return res.ok;
    } catch { return false; }
  },
};

export const communiquesApi = {
  get: (eventId: string) => api.get<CommuniqueSource | null>(`/api/communiques/${eventId}`),

  setSource: (eventId: string, shareToken: string, label?: string) =>
    api.post<CommuniqueSource>(`/api/communiques/${eventId}`, { shareToken, label }),

  poll: (eventId: string) =>
    api.post<{ newCount: number; newDocs: CommuniqueDocument[] }>(`/api/communiques/${eventId}/poll`, {}),

  getVapidPublicKey: () =>
    api.get<{ key: string }>('/api/communiques/vapid-public-key'),

  subscribe: (eventId: string, subscription: PushSubscriptionJSON, akFilter: string[]) =>
    api.post(`/api/communiques/${eventId}/subscribe`, {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      akFilter,
    }),

  unsubscribe: (endpoint: string) =>
    api.delete(`/api/communiques/subscribe?endpoint=${encodeURIComponent(endpoint)}`),
};
