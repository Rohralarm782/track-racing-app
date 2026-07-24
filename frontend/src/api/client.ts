// Zielpfad im Repo: frontend/src/api/client.ts  (ERSETZT die bestehende Datei)
// Änderungen ggü. Original:
//  - Race: distanceM, athletes hinzugefügt
//  - neue Typen Athlete, AthleteRaceTime, AthleteDetail
//  - neue athletesApi, raceAthletesApi
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

// ─── Sportlerkartei ─────────────────────────────────────────────────────────

export interface Athlete {
  id: string;
  vorname: string;
  nachname: string;
  ak?: string | null;
  notes?: string | null;
  kettenblaetter: number[];
  ritzel: number[];
  createdAt: string;
  updatedAt: string;
  _count?: { raceLinks: number };
}

/** Kurzanzeige (z.B. Chips, Dropdowns während des Rennens): nur Vorname. */
export function athleteShortName(a: Athlete): string { return a.vorname; }
/** Vollständiger Name (z.B. Sportlerkartei, Formulare, Disambiguierung). */
export function athleteFullName(a: Athlete): string { return `${a.vorname} ${a.nachname}`.trim(); }

export interface AthleteRaceTime {
  raceId: string;
  raceName: string;
  eventName: string | null;
  ak: string | null;
  distanceM: number | null;
  timeMs: number;
}

export interface AthleteDetail extends Athlete {
  times: AthleteRaceTime[];
}

export interface RaceAthleteLink {
  id: string;
  raceId: string;
  athleteId: string;
  timeMs: number | null;
  athlete: Athlete;
}

// ─── Führungsplan Mannschaftsverfolgung (nur Planung/Visualisierung) ────────

export interface FuehrungsplanData {
  riderOrder: string[];
  riderModes: Record<string, 'back' | 'dropout'>;
  dropoutRound: number;
  segments: { athleteId: string; laps: number }[];
  /** Gang pro Sportler (Mannschaftsverfolgung) — optional, alte gespeicherte
   *  Pläne haben das Feld noch nicht. */
  riderGears?: Record<string, { kb: number; rz: number } | null>;
}

export interface Race {
  id: string;
  name: string;
  type: RaceType;
  status: RaceStatus;
  order: number;
  ak?: string | null; // nur bei Rennen ohne Kategorie (neues Modell)
  format?: CategoryFormat | null;
  distanceM?: number | null; // grobe Distanz (Verfolgungsrennen), optional
  athletes?: RaceAthleteLink[]; // verknüpfte Sportler aus der Kartei (Verfolgungsrennen)
  fuehrungsplan?: FuehrungsplanData | null; // Führungsplan Mannschaftsverfolgung
  _count?: { teams: number };
}

export interface Event {
  id: string;
  name: string;
  date?: string | null;
  categories: Array<Category & { _count: { teams: number }; races: Race[] }>;
  races: Race[]; // neue, direkt am Event hängende Rennen ohne Kategorie
}

export type DocType = 'STARTLISTE' | 'ERGEBNIS' | 'ZEITPLAN' | 'SONSTIGES';
export type Discipline = 'SPRINT' | 'AUSDAUER' | 'ALLGEMEIN';

export interface MevRider {
  name: string;
  lauf: number | null;
  // Textueller Lauf, wenn die Lauf-Spalte keine Zahl enthält — z.B. "Platz 3/4"
  // im Sprint-Finale. Entweder lauf ODER laufLabel ist gesetzt, nie beides.
  laufLabel?: string | null;
  team: string | null;
  // Startposition auf der Bahn: ZG/GG = Ziel-/Gegengerade (Einzelstart),
  // B/M = Ballustrade/Messlinie (Massenstart). Fehlt bei Dokumenten, die vor
  // Einführung der Erkennung analysiert wurden (wird beim Poll nachgetragen).
  startPos?: 'ZG' | 'GG' | 'B' | 'M' | null;
  // Nur im Massenstart: Platz innerhalb der Ballustrade-/Messlinien-Reihe (1-basiert)
  startSlot?: number | null;
}

export interface CommuniqueDocument {
  id: string;
  sourceId: string;
  fileName: string;
  docType: DocType;
  ak: string;
  discipline: Discipline;
  isPinned: boolean;
  isHidden?: boolean;
  remoteModifiedAt: string;
  discoveredAt: string;
  remoteUrl?: string | null;
  disciplineCode?: string | null;
  phaseLabel?: string | null;
  mevNames?: string[];
  mevRiders?: MevRider[];
  heatCount?: number | null;
  starterCount?: number | null;
  roundCount?: number | null;
  mevAnalyzedAt?: string | null;
  // Automatische Ersetzung: gesetzt, wenn eine neuere Fassung desselben
  // Kommuniqués existiert (K12 → K12B). supersededBy trägt den Nachfolger für
  // die Anzeige „ersetzt durch K12B".
  supersededById?: string | null;
  supersededBy?: { id: string; fileName: string } | null;
  // Gesetzt, wenn die Datei beim letzten vollständigen Poll nicht mehr in der
  // Quelle lag (ISO-Zeitstempel des ersten Fehlens).
  missingSince?: string | null;
}

export type CommuniqueSourceType = 'WEBDAV' | 'HTML';

export interface CommuniqueSource {
  id: string;
  eventId: string;
  sourceType: CommuniqueSourceType;
  shareToken: string | null;   // nur WEBDAV
  htmlPageUrls: string[];      // nur HTML
  label: string | null;
  lastPolledAt: string | null;
  documents: CommuniqueDocument[];
}

// Konfiguration, die der Setup-Endpunkt erwartet — je nach sourceType ist
// entweder shareToken (WEBDAV) oder htmlPageUrls (HTML) gesetzt.
export interface CommuniqueSourceConfig {
  sourceType: CommuniqueSourceType;
  shareToken?: string;
  htmlPageUrls?: string[];
  label?: string;
  // true = beim Speichern alle bereits gefundenen Dokumente dieser Quelle
  // löschen (sinnvoll, wenn die Links komplett umgezogen sind).
  purgeDocuments?: boolean;
}

// ─── Zeitplan ────────────────────────────────────────────────────────────────

export type ScheduleEntryType = 'RACE' | 'CEREMONY' | 'INFO';
export type LiveStatusKey = 'STARTING' | 'RUNNING' | 'FINISHED' | 'STARTS_AT';

export interface ScheduleEntryLinkedDoc {
  id: string;
  fileName: string;
  // Wird als Cache-Version (?v=) für die Offline-Vorabspeicherung genutzt.
  remoteModifiedAt: string;
  mevNames: string[];
  mevRiders: MevRider[];
  heatCount: number | null;
  roundCount: number | null;
  starterCount: number | null;
  mevAnalyzedAt: string | null;
}

export interface ScheduleEntryResultDoc {
  id: string;
  fileName: string;
  // Wird als Cache-Version (?v=) für die Offline-Vorabspeicherung genutzt.
  remoteModifiedAt: string;
}

export interface ScheduleEntry {
  id: string;
  eventId: string;
  day: number;
  dayLabel: string | null;
  time: string;
  ak: string;
  disciplineLabel: string;
  phase: string | null;
  type: ScheduleEntryType;
  massStart: boolean;
  order: number;
  linkedDocumentId: string | null;
  linkedDocument: ScheduleEntryLinkedDoc | null;
  linkedResultDocumentId: string | null;
  linkedResultDocument: ScheduleEntryResultDoc | null;
  // Manuell eingetragene Runden-/Laufzahl, überschreibt Startliste + Rückfallgröße.
  manualUnitCount: number | null;
  // Vom Veranstalter im Zeitplan geplante Dauer (Minuten), falls angegeben —
  // wird in der Schätzung bevorzugt, solange keine Startliste/manuelle Zahl da ist.
  plannedDurationMin: number | null;
  // Geschätzte Renndauer in Minuten (Formel + Kalibrierungsfaktor, siehe
  // durationEstimate.ts) — null, wenn (noch) nicht schätzbar, z.B. weil die
  // Runden-/Laufzahl aus der Startliste fehlt.
  estimatedMinutes: number | null;
  // true, wenn die Schätzung auf einer Rückfallgröße statt einer echten
  // Runden-/Laufzahl beruht — Signal fürs Frontend, eine manuelle Eingabe anzubieten.
  estimateIsFallback: boolean;
}

export interface DraftScheduleEntry {
  day: number;
  dayLabel?: string | null;
  time: string;
  ak: string;
  disciplineLabel: string;
  phase?: string | null;
  type: ScheduleEntryType;
  massStart: boolean;
  plannedDurationMin?: number | null;
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

  setSource: (eventId: string, config: CommuniqueSourceConfig) =>
    api.post<CommuniqueSource>(`/api/communiques/${eventId}`, config),

  poll: (eventId: string) =>
    api.post<{ newCount: number; newDocs: CommuniqueDocument[] }>(`/api/communiques/${eventId}/poll`, {}),

  // version (= remoteModifiedAt des Dokuments) wird als ?v= angehängt und dient
  // dem Service Worker als Cache-Schlüssel: neue Dateiversion ⇒ neue URL ⇒ die
  // veraltete gecachte Version wird nie fälschlich ausgeliefert. Ohne version
  // bleibt die URL unversioniert und wird bewusst NICHT offline gecacht.
  fileUrl: (eventId: string, documentId: string, version?: string | null) =>
    `${API_URL}/api/communiques/${eventId}/file/${documentId}` +
    (version ? `?v=${encodeURIComponent(version)}` : ''),

  togglePin: (eventId: string, documentId: string, pinned: boolean) =>
    api.patch<CommuniqueDocument>(`/api/communiques/${eventId}/documents/${documentId}/pin`, { pinned }),

  toggleHide: (eventId: string, documentId: string, hidden: boolean) =>
    api.patch<CommuniqueDocument>(`/api/communiques/${eventId}/documents/${documentId}/hide`, { hidden }),

  reanalyzeMev: (eventId: string, documentId: string) =>
    api.post<CommuniqueDocument>(`/api/communiques/${eventId}/documents/${documentId}/reanalyze-mev`, {}),

  importSchedule: (eventId: string, documentId: string) =>
    api.post<void>(`/api/communiques/${eventId}/documents/${documentId}/import-schedule`, {}),

  getVapidPublicKey: () =>
    api.get<{ key: string }>('/api/communiques/vapid-public-key'),

  subscribe: (
    eventId: string, subscription: PushSubscriptionJSON,
    akFilter: string[], disciplineFilter: string[],
    matrixFilter?: Record<string, string[]> | null,
  ) =>
    api.post(`/api/communiques/${eventId}/subscribe`, {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      akFilter,
      disciplineFilter,
      matrixFilter: matrixFilter ?? null,
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

  deleteDay: (eventId: string, day: number) =>
    api.delete<ScheduleEntry[]>(`/api/events/${eventId}/schedule/days/${day}`),

  linkDocument: (entryId: string, linkedDocumentId: string | null) =>
    api.patch<ScheduleEntry>(`/api/schedule-entries/${entryId}`, { linkedDocumentId }),

  linkResultDocument: (entryId: string, linkedResultDocumentId: string | null) =>
    api.patch<ScheduleEntry>(`/api/schedule-entries/${entryId}`, { linkedResultDocumentId }),

  setManualUnitCount: (entryId: string, manualUnitCount: number | null) =>
    api.patch<ScheduleEntry>(`/api/schedule-entries/${entryId}`, { manualUnitCount }),

  getStatus: (eventId: string) =>
    api.get<EventStatus | null>(`/api/events/${eventId}/status`),

  setStatus: (eventId: string, scheduleEntryId: string, statusKey: LiveStatusKey, roundsLeft: number | null, announcedTime?: string) =>
    api.put<EventStatus>(`/api/events/${eventId}/status`, { scheduleEntryId, statusKey, roundsLeft, announcedTime }),
};

// ─── Sportlerkartei ─────────────────────────────────────────────────────────

export const athletesApi = {
  list: () => api.get<Athlete[]>('/api/athletes'),
  get: (id: string) => api.get<AthleteDetail>(`/api/athletes/${id}`),
  create: (data: { vorname: string; nachname: string; ak?: string | null; notes?: string | null; kettenblaetter?: number[]; ritzel?: number[] }) =>
    api.post<Athlete>('/api/athletes', data),
  update: (id: string, data: Partial<{ vorname: string; nachname: string; ak: string | null; notes: string | null; kettenblaetter: number[]; ritzel: number[] }>) =>
    api.patch<Athlete>(`/api/athletes/${id}`, data),
  delete: (id: string) => api.delete<void>(`/api/athletes/${id}`),
};

export const raceAthletesApi = {
  set: (raceId: string, athleteIds: string[]) =>
    api.put<RaceAthleteLink[]>(`/api/races/${raceId}/athletes`, { athleteIds }),
};

export const raceFuehrungsplanApi = {
  set: (raceId: string, data: FuehrungsplanData) =>
    api.patch<{ id: string; fuehrungsplan: FuehrungsplanData }>(`/api/races/${raceId}/fuehrungsplan`, data),
};

// ─── Allgemeine Einstellungen (App-weit, nicht pro Veranstaltung) ──────────

export interface AppSettings {
  id: string;
  mevLv: string;
  massStartSetupMin: number;
  massStartPerRoundMin: number;
  massStartClearMin: number;
  afSetupMin: number;
  afPerRoundMin: number;
  afClearMin: number;
  pursuitSetupMin: number;
  // Renndauer je Distanz getrennt nach Geschlecht (m/w). Bestehende Datensätze
  // können übergangsweise noch flache Zahlen enthalten, bis einmal gespeichert
  // wurde — die UI normalisiert das beim Anzeigen (siehe TimeEstimateSettings).
  distanceRaceMinutes: Record<string, { m: number; w: number }>;
  sprintPerHeatMin: number;
  teamsprintPerHeatMin: number;
  keirinPerHeatMin: number;
  pauseBufferMin: number;
  estimateThresholdMin: number;
  fallbackRoundCountPr: number;
  fallbackRoundCountTr: number;
  fallbackRoundCountDefault: number;
  fallbackHeatCount: number;
  pursuitFinalHeatCount: number;
  updatedAt: string;
}

export interface DurationEstimateRow {
  id: string;
  ak: string;
  disciplineLabel: string;
  massStart: boolean;
  correctionFactor: number;
  sampleCount: number;
  updatedAt: string;
}

export const settingsApi = {
  get: () => api.get<AppSettings>('/api/settings'),
  update: (data: Partial<AppSettings>) => api.put<AppSettings>('/api/settings', data),
  getCalibration: () => api.get<DurationEstimateRow[]>('/api/settings/calibration'),
  resetCalibration: (id: string) => api.delete<void>(`/api/settings/calibration/${id}`),
};
