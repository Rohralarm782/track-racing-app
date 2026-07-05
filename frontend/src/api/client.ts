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
  lv?: string | null;
  rider2Lv?: string | null;
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
  ak?: string | null; // nur bei Rennen ohne Kategorie (neues Modell)
  _count?: { teams: number };
}

export interface Event {
  id: string;
  name: string;
  date?: string | null;
  categories: Array<Category & { _count: { teams: number }; races: Race[] }>;
  races: Race[]; // neue, direkt am Event hängende Rennen ohne Kategorie
}

export type DocType = 'STARTLISTE' | 'ERGEBNIS' | 'SONSTIGES';
export type Discipline = 'SPRINT' | 'AUSDAUER' | 'ALLGEMEIN';

export interface CommuniqueDocument {
  id: string;
  sourceId: string;
  fileName: string;
  docType: DocType;
  ak: string;
  discipline: Discipline;
  isPinned: boolean;
  remoteModifiedAt: string;
  discoveredAt: string;
  disciplineCode?: string | null;
  phaseLabel?: string | null;
  mevNames?: string[];
  mevAnalyzedAt?: string | null;
}

export interface CommuniqueSource {
  id: string;
  eventId: string;
  shareToken: string;
  label: string | null;
  lastPolledAt: string | null;
  documents: CommuniqueDocument[];
}

// ─── Zeitplan ────────────────────────────────────────────────────────────────

export type ScheduleEntryType = 'RACE' | 'CEREMONY' | 'INFO';
export type LiveStatusKey = 'STARTING' | 'RUNNING' | 'FINISHED';

export interface ScheduleEntryLinkedDoc {
  id: string;
  fileName: string;
  mevNames: string[];
  mevAnalyzedAt: string | null;
}

export interface ScheduleEntry {
  id: string;
  eventId: string;
  day: number;
  time: string;
  ak: string;
  disciplineLabel: string;
  phase: string | null;
  type: ScheduleEntryType;
  massStart: boolean;
  order: number;
  linkedDocumentId: string | null;
  linkedDocument: ScheduleEntryLinkedDoc | null;
}

export interface DraftScheduleEntry {
  day: number;
  time: string;
  ak: string;
  disciplineLabel: string;
  phase?: string | null;
  type: ScheduleEntryType;
  massStart: boolean;
}

export interface EventStatus {
  id: string;
  eventId: string;
  scheduleEntryId: string;
  statusKey: LiveStatusKey;
  roundsLeft: number | null;
  offsetMinutes: number;
  updatedAt: string;
  scheduleEntry: ScheduleEntry;
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

  fileUrl: (eventId: string, documentId: string) =>
    `${API_URL}/api/communiques/${eventId}/file/${documentId}`,

  togglePin: (eventId: string, documentId: string, pinned: boolean) =>
    api.patch<CommuniqueDocument>(`/api/communiques/${eventId}/documents/${documentId}/pin`, { pinned }),

  getVapidPublicKey: () =>
    api.get<{ key: string }>('/api/communiques/vapid-public-key'),

  subscribe: (eventId: string, subscription: PushSubscriptionJSON, akFilter: string[], disciplineFilter: string[]) =>
    api.post(`/api/communiques/${eventId}/subscribe`, {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      akFilter,
      disciplineFilter,
    }),

  unsubscribe: (endpoint: string) =>
    api.delete(`/api/communiques/subscribe?endpoint=${encodeURIComponent(endpoint)}`),
};

export const scheduleApi = {
  analyze: (eventId: string, pdfBase64: string) =>
    api.post<{ entries: DraftScheduleEntry[] }>(`/api/events/${eventId}/schedule/analyze`, { pdfBase64 }),

  save: (eventId: string, entries: DraftScheduleEntry[]) =>
    api.post<ScheduleEntry[]>(`/api/events/${eventId}/schedule`, { entries }),

  list: (eventId: string) =>
    api.get<ScheduleEntry[]>(`/api/events/${eventId}/schedule`),

  rematch: (eventId: string) =>
    api.post<ScheduleEntry[]>(`/api/events/${eventId}/schedule/rematch`, {}),

  linkDocument: (entryId: string, linkedDocumentId: string | null) =>
    api.patch<ScheduleEntry>(`/api/schedule-entries/${entryId}`, { linkedDocumentId }),

  getStatus: (eventId: string) =>
    api.get<EventStatus | null>(`/api/events/${eventId}/status`),

  setStatus: (eventId: string, scheduleEntryId: string, statusKey: LiveStatusKey, roundsLeft: number | null) =>
    api.put<EventStatus>(`/api/events/${eventId}/status`, { scheduleEntryId, statusKey, roundsLeft }),
};
