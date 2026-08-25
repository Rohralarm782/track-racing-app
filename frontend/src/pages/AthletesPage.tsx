// Zielpfad im Repo: frontend/src/pages/AthletesPage.tsx  (ERSETZT die bestehende Datei)
// Änderungen ggü. Original:
//  - Suchfeld: umlauttolerant (schroder/schroeder → Schröder), mehrere Begriffe
//    UND-verknüpft ("schmidt u15"), sucht in Name + AK, Treffer werden markiert.
//  - Gruppierung nach Altersklasse; Gruppen starten zugeklappt. Welche Gruppen
//    offen sind, merkt localStorage, damit ein Sprung ins Profil und zurück die
//    Ansicht nicht zurücksetzt.
//  - Sobald gesucht wird, werden alle Gruppen mit Treffern aufgeklappt — sonst
//    versteckt das Zuklappen die Suchergebnisse.
//  - Kompakte Zeilen statt Karten (~38 statt ~72 px pro Sportler).
//  - Sortierung innerhalb der Gruppe nach Vorname (wie bisher; das Backend
//    liefert bereits vorname asc, hier nochmal clientseitig, weil hier
//    umgruppiert wird).
//  - Meta rechts in der Zeile: "N Zeiten · KB×RZ Gänge" statt der alten
//    Zweitzeile. Gezählt werden die gefahrenen Läufe aus PursuitRun; die Zahl
//    liefert das Backend als `runCount` (GET /api/athletes), weil athleteIds
//    eine String-Liste und keine Relation ist und Prisma dort nicht zählen
//    kann. Der frühere Wert `_count.raceLinks` zählte Rennverknüpfungen und
//    war trackside durchgehend 0 — er wird nicht mehr angezeigt.
//    Bei 0 Läufen entfällt der Teil ganz: eine Null trägt keine Information
//    und macht die Zeile nur unruhig.
//  - Kein Schema-Eingriff. Braucht Backend-Stand 1.3.0; gegen ein älteres
//    Backend fehlt `runCount` und der Zeitenteil entfällt wie bei 0 Läufen.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { athletesApi, athleteFullName, type Athlete } from '../api/client';
import { useAdmin } from '../components/Layout';

const OPEN_KEY = 'athletes_open_aks';
const NO_AK = '\u0000ohne';           // Gruppenschlüssel für Sportler ohne AK
const NO_AK_LABEL = 'Ohne Altersklasse';

// ── Suche ────────────────────────────────────────────────────────────────────
// Faltet Groß-/Kleinschreibung und Umlaute so, dass "Schröder", "schroder" und
// "schroeder" auf dieselbe Zeichenkette abbilden — beide gängigen Ersatz-
// schreibweisen müssen finden. Dazu zwei Stufen:
//   1. ä/ö/ü → a/o/u, ß → ss
//   2. ae/oe/ue → a/o/u
// Die Länge ändert sich dabei in beide Richtungen, deshalb liefert fold() eine
// Indexkarte mit: map[i] = Liste der Positionen im Originaltext, aus denen das
// i-te Zeichen der gefalteten Fassung stammt. Nur damit lässt sich ein Treffer
// aus der gefalteten Suche wieder korrekt im Original markieren.
const FOLD: Record<string, string> = { 'ä': 'a', 'ö': 'o', 'ü': 'u', 'ß': 'ss' };

function fold(s: string): { n: string; map: number[][] } {
  // Stufe 1 – zeichenweise
  const chars: string[] = [];
  const src: number[][] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i].toLowerCase();
    const rep = FOLD[ch] ?? ch;
    for (const c of rep) { chars.push(c); src.push([i]); }
  }
  // Stufe 2 – ae/oe/ue zusammenziehen
  const out: string[] = [];
  const map: number[][] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (chars[i + 1] === 'e' && (c === 'a' || c === 'o' || c === 'u')) {
      out.push(c);
      map.push([...src[i], ...src[i + 1]]);
      i++;
    } else {
      out.push(c);
      map.push(src[i]);
    }
  }
  return { n: out.join(''), map };
}
const foldStr = (s: string) => fold(s).n;

/** Markiert alle Vorkommen der Suchbegriffe im Originaltext. */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length || !text) return <>{text}</>;
  const { n, map } = fold(text);
  const hit = new Array<boolean>(text.length).fill(false);
  let any = false;
  for (const t of terms) {
    let i = n.indexOf(t);
    while (i !== -1) {
      for (let k = i; k < i + t.length; k++) {
        for (const o of map[k]) { hit[o] = true; any = true; }
      }
      i = n.indexOf(t, i + 1);
    }
  }
  if (!any) return <>{text}</>;

  const parts: ReactNode[] = [];
  let buf = '';
  let on = hit[0];
  const flush = () => {
    if (!buf) return;
    parts.push(on
      ? <mark key={parts.length} className="ath-mark">{buf}</mark>
      : <span key={parts.length}>{buf}</span>);
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    if (hit[i] !== on) { flush(); on = hit[i]; }
    buf += text[i];
  }
  flush();
  return <>{parts}</>;
}

// ── Altersklassen-Reihenfolge ────────────────────────────────────────────────
// AK ist freier Text ("U17 m", "Junioren", "Elite w", …). Sortiert wird nach
// Altersstufe, dann m vor w, dann alphabetisch als Rückfallebene.
//
// Bewusst NICHT foldStr(): dessen zweite Stufe zieht "ue" zusammen und macht
// aus "Frauen" ein "fraun", worauf /frauen/ nicht mehr passt. Für die
// AK-Einordnung reicht Kleinschreibung plus Umlaute auf einen Buchstaben.
const plain = (s: string) =>
  s.toLowerCase().replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss');

function akRank(ak: string): [number, number, string] {
  const s = plain(ak);
  let age = 500;
  const u = s.match(/u\s*(\d{1,2})/);
  if (u) age = parseInt(u[1], 10);
  else if (/schuler/.test(s)) age = 14;      // "Schüler" → gefaltet "schuler"
  else if (/jugend/.test(s)) age = 17;
  else if (/junior/.test(s)) age = 19;
  else if (/elite|frauen|manner|senior|master/.test(s)) age = 900;

  let gender = 2;
  if (/(^|\s)w(\s|$)|weiblich|frauen/.test(s)) gender = 1;
  else if (/(^|\s)m(\s|$)|mannlich|manner/.test(s)) gender = 0;

  return [age, gender, s];
}

function compareAk(a: string, b: string): number {
  if (a === NO_AK) return 1;
  if (b === NO_AK) return -1;
  const [aAge, aGen, aStr] = akRank(a);
  const [bAge, bGen, bStr] = akRank(b);
  return aAge - bAge || aGen - bGen || aStr.localeCompare(bStr, 'de');
}

const byVorname = (a: Athlete, b: Athlete) =>
  a.vorname.localeCompare(b.vorname, 'de') || a.nachname.localeCompare(b.nachname, 'de');

// ── Seite ────────────────────────────────────────────────────────────────────
export default function AthletesPage() {
  const { isAdmin } = useAdmin();
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [loading, setLoading]   = useState(true);
  const [showNew, setShowNew]   = useState(false);
  const [vorname, setVorname]   = useState('');
  const [nachname, setNachname] = useState('');
  const [ak, setAk]             = useState('');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  const [query, setQuery]     = useState('');
  const [openAks, setOpenAks] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(OPEN_KEY);
      return new Set<string>(raw ? JSON.parse(raw) : []);
    } catch { return new Set<string>(); }
  });

  useEffect(() => {
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...openAks])); } catch { /* egal */ }
  }, [openAks]);

  function load() {
    setLoading(true);
    athletesApi.list().then(setAthletes).catch(e => setError(e.message)).finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function createAthlete() {
    if (!vorname.trim() || !nachname.trim()) return;
    setSaving(true); setError('');
    try {
      await athletesApi.create({ vorname: vorname.trim(), nachname: nachname.trim(), ak: ak.trim() || null });
      setVorname(''); setNachname(''); setAk(''); setShowNew(false);
      load();
    } catch (e: any) { setError(e.message ?? 'Fehler'); }
    finally { setSaving(false); }
  }

  const terms = useMemo(
    () => foldStr(query).split(/\s+/).filter(Boolean),
    [query],
  );
  const searching = terms.length > 0;

  const groups = useMemo(() => {
    const hits = !searching ? athletes : athletes.filter(a => {
      const hay = foldStr(`${athleteFullName(a)} ${a.ak ?? ''}`);
      return terms.every(t => hay.includes(t));
    });

    const map = new Map<string, Athlete[]>();
    for (const a of hits) {
      const key = a.ak?.trim() || NO_AK;
      const list = map.get(key);
      if (list) list.push(a); else map.set(key, [a]);
    }
    return [...map.entries()]
      .sort((x, y) => compareAk(x[0], y[0]))
      .map(([key, list]) => ({ key, list: list.sort(byVorname) }));
  }, [athletes, terms, searching]);

  const shown = groups.reduce((n, g) => n + g.list.length, 0);
  const allOpen = groups.length > 0 && groups.every(g => openAks.has(g.key));

  function toggleGroup(key: string) {
    setOpenAks(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function metaLine(a: Athlete): string {
    const parts: string[] = [];
    const runs = a.runCount ?? 0;
    if (runs > 0) parts.push(runs === 1 ? '1 Zeit' : `${runs} Zeiten`);
    if (a.kettenblaetter.length || a.ritzel.length) {
      parts.push(`${a.kettenblaetter.length}\u00d7${a.ritzel.length} Gänge`);
    }
    return parts.join(' · ');
  }

  return (
    <div className="page container">
      <style>{ATH_CSS}</style>

      <div className="breadcrumb">
        <Link to="/">Veranstaltungen</Link><span>›</span>Sportler
      </div>
      <div className="flex-between mb-4">
        <h1>Sportler</h1>
        {isAdmin && (
          <button className="btn btn-primary btn-sm" onClick={() => setShowNew(v => !v)}>
            {showNew ? '✕ Schließen' : '+ Neuer Sportler'}
          </button>
        )}
      </div>

      {error && <div className="alert alert-error mb-3">{error}</div>}

      {showNew && (
        <div className="card mb-3" style={{ borderColor: '#bfdbfe', background: '#f0f7ff' }}>
          <div className="grid-3">
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Vorname</label>
              <input
                className="form-input"
                value={vorname}
                onChange={e => setVorname(e.target.value)}
                placeholder="z.B. Max"
                onKeyDown={e => e.key === 'Enter' && createAthlete()}
                autoFocus
              />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Nachname</label>
              <input
                className="form-input"
                value={nachname}
                onChange={e => setNachname(e.target.value)}
                placeholder="z.B. Mustermann"
                onKeyDown={e => e.key === 'Enter' && createAthlete()}
              />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Altersklasse</label>
              <input className="form-input" value={ak} onChange={e => setAk(e.target.value)} placeholder="z.B. U17 m" />
            </div>
          </div>
          <div className="flex-between mt-3">
            <button className="btn btn-ghost btn-sm" onClick={() => setShowNew(false)}>Abbrechen</button>
            <button className="btn btn-primary" onClick={createAthlete} disabled={saving || !vorname.trim() || !nachname.trim()}>
              {saving ? 'Speichert…' : 'Sportler anlegen'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="loading"><span className="spinner" /> Lädt…</div>
      ) : athletes.length === 0 ? (
        <div className="empty"><p>Noch keine Sportler angelegt.</p></div>
      ) : (
        <>
          <div className="ath-search">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
            </svg>
            <input
              className="form-input"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Name oder Altersklasse suchen…"
              autoComplete="off"
              spellCheck={false}
            />
            {query && (
              <button className="ath-clear" onClick={() => setQuery('')} aria-label="Suche löschen">✕</button>
            )}
          </div>

          <div className="ath-resultline">
            <span>
              {shown === athletes.length
                ? `${athletes.length} Sportler`
                : `${shown} von ${athletes.length} Sportlern`}
            </span>
            {!searching && groups.length > 1 && (
              <button
                className="ath-linkbtn"
                onClick={() => setOpenAks(allOpen ? new Set() : new Set(groups.map(g => g.key)))}
              >
                {allOpen ? 'Alle zuklappen' : 'Alle aufklappen'}
              </button>
            )}
          </div>

          {groups.length === 0 ? (
            <div className="empty"><p>Kein Sportler gefunden.</p></div>
          ) : (
            groups.map(g => {
              const open = searching || openAks.has(g.key);
              return (
                <div className="ath-group" key={g.key}>
                  <button
                    className={`ath-ghead${open ? '' : ' closed'}`}
                    onClick={() => toggleGroup(g.key)}
                    aria-expanded={open}
                  >
                    <span className="tw">▼</span>
                    {g.key === NO_AK ? NO_AK_LABEL : g.key}
                    <span className="n">{g.list.length}</span>
                  </button>
                  {open && (
                    <div className="ath-list">
                      {g.list.map(a => (
                        <Link key={a.id} to={`/athletes/${a.id}`} className="ath-row">
                          <span className="ath-name">
                            <Highlight text={athleteFullName(a)} terms={terms} />
                          </span>
                          <span className="ath-meta">{metaLine(a)}</span>
                          <span className="ath-chev">›</span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </>
      )}
    </div>
  );
}

// Komponentenlokal statt in globals.css, damit die Änderung eine einzige Datei
// bleibt. `top: 54px` bei .ath-ghead entspricht der Höhe von .header (sticky).
const ATH_CSS = `
.ath-search { position: relative; margin-bottom: 4px; }
.ath-search > svg { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--c-text-muted); pointer-events: none; }
.ath-search .form-input { padding-left: 34px; padding-right: 34px; }
.ath-clear { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); border: 0; background: transparent; color: var(--c-text-muted); cursor: pointer; font-size: 15px; line-height: 1; padding: 5px 6px; font-family: inherit; }
.ath-clear:hover { color: var(--c-text); }

.ath-resultline { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px; color: var(--c-text-muted); margin: 10px 2px 8px; }
.ath-linkbtn { border: 0; background: transparent; color: var(--c-primary); font: inherit; font-size: 12px; cursor: pointer; padding: 0; }
.ath-linkbtn:hover { text-decoration: underline; }

.ath-group { margin-bottom: 14px; }
.ath-ghead { display: flex; align-items: center; gap: 8px; width: 100%; background: var(--c-bg); border: 0; padding: 7px 4px; margin: 0; font: inherit; font-size: 12.5px; font-weight: 600; color: var(--c-text-muted); text-transform: uppercase; letter-spacing: .05em; cursor: pointer; position: sticky; top: 54px; z-index: 4; }
.ath-ghead:hover { color: var(--c-text); }
.ath-ghead .tw { display: inline-block; font-size: 10px; transition: transform .15s; }
.ath-ghead.closed .tw { transform: rotate(-90deg); }
.ath-ghead .n { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 500; font-variant-numeric: tabular-nums; }

.ath-list { background: var(--c-white); border: 1px solid var(--c-border); border-radius: 10px; overflow: hidden; }
.ath-row { display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-bottom: 1px solid var(--c-border); text-decoration: none; color: inherit; }
.ath-row:last-child { border-bottom: none; }
.ath-row:hover { background: #f8faff; text-decoration: none; }
.ath-name { font-weight: 500; font-size: 14.5px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ath-meta { font-size: 12px; color: var(--c-text-muted); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.ath-chev { color: #d1d5db; flex-shrink: 0; font-size: 14px; }
.ath-mark { background: #fef08a; color: inherit; border-radius: 2px; padding: 0 1px; }

@media (max-width: 560px) {
  .ath-meta { display: none; }
}
`;
