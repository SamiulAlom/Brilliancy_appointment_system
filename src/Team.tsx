import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlarmClock, Award, Building2, CalendarDays, CalendarRange, CheckCircle2, ClipboardList, KeyRound, LogOut, Mail, MessageCircle, Phone, PhoneCall, PhoneMissed, RefreshCw, Search, UserCheck, Video } from 'lucide-react';
import Brand from './Brand';
import SignIn from './SignIn';
import { api, type Mode } from './lib/api';
import { addDays, dhakaDate, fmtDateTime, fmtDay, fmtTime } from './lib/time';

type TBooking = { id: string; start_at: string; end_at: string; duration_min: number; service_name: string; mode: Mode; meet_link: string | null; status: string;
  client_name: string; client_phone: string; client_email: string; client_institution: string; client_note: string; created_at: string; referrer_label: string;
  follow_status: string; follow_up_at: string | null; last_contact_at: string | null; assigned_to: string | null; assigned_name: string | null };
type Activity = { id: number; actor_type: string; actor_name: string; outcome: string | null; follow_status: string | null; follow_up_at: string | null; note: string | null; created_at: string };
type Member = { id: string; full_name: string; email?: string };
type View = 'due' | 'today' | 'upcoming' | 'range';
type Payload = { bookings: TBooking[]; members: Member[]; follow_labels: Record<string, string>; outcome_labels: Record<string, string> };

export const FOLLOW: Record<string, string> = { new: 'To call', called: 'Contacted', no_answer: 'No answer', follow_up: 'Call back', done: 'Done' };
export const OUTCOME: Record<string, string> = { reached: 'Spoke with client', no_answer: 'No answer', busy: 'Busy / call later', wrong_number: 'Wrong number', whatsapp: 'Messaged on WhatsApp', email: 'Sent an email', note: 'Note' };
const STATUS: Record<string, string> = { calendar_pending: 'Confirmed', confirmed: 'Confirmed', completed: 'Completed', no_show: 'No-show', cancelled: 'Cancelled' };
const MODE: Record<Mode, string> = { office: 'At office', meet: 'Google Meet', phone: 'Phone call' };
const TOKEN_KEY = 'brilliancy-appointments-team';
const readToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const writeToken = (t: string | null) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } };
const waLink = (phone: string, text = '') => `https://wa.me/${phone.replace(/\D/g, '').replace(/^0/, '880')}${text ? '?text=' + encodeURIComponent(text) : ''}`;
// datetime-local works in the viewer's clock; the office is in Dhaka, so convert explicitly.
const toLocalInput = (iso: string | null) => { if (!iso) return ''; const d = new Date(Date.parse(iso) + 6 * 3600e3); return d.toISOString().slice(0, 16); };
const fromLocalInput = (v: string) => v ? new Date(Date.parse(v + ':00+06:00')).toISOString() : null;
const ago = (iso: string) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60e3); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : fmtDateTime(iso); };

export default function Team() {
  const [token, setTokenState] = useState<string | null>(readToken);
  const [me, setMe] = useState<Member | null>(null);
  const [authError, setAuthError] = useState('');
  const setToken = (t: string | null) => { writeToken(t); setTokenState(t); };
  useEffect(() => {
    if (!token) { setMe(null); return; }
    api<{ member: Member }>('/api/team/me', { token }).then(r => setMe(r.member)).catch((e: Error & { code?: string }) => {
      if (['TEAM_REQUIRED', 'SESSION_EXPIRED', 'SIGN_IN_REQUIRED'].includes(e.code || '')) { setToken(null); setAuthError(e.code === 'SIGN_IN_REQUIRED' ? '' : e.message); }
      else setAuthError(e.message);
    });
  }, [token]);
  useEffect(() => { document.title = 'Communication team · Brilliancy Research'; }, []);
  if (!token || !me) return <SignIn initial="team" error={authError} onToken={(_r, t) => setToken(t)}/>;
  return <Portal token={token} me={me} signOut={() => setToken(null)}/>;
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const HUES = [356, 18, 200, 262, 152, 330, 40, 222];
const hue = (name: string) => HUES[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
const MODE_ICON: Record<Mode, typeof Video> = { office: Building2, meet: Video, phone: Phone };
function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  return <span className="avatar" style={{ width: size, height: size, fontSize: size * .36, background: `hsl(${hue(name)} 70% 94%)`, color: `hsl(${hue(name)} 55% 34%)` }}>{initials(name)}</span>;
}
function Referrer({ label }: { label: string }) {
  if (label === 'No one') return <span className="ref-tag none">No referrer</span>;
  return <span className="ref-tag"><Award size={13}/> Referred by <b>{label.replace(/^Other: /, '')}</b>{label.startsWith('Other: ') && <em> (not staff)</em>}</span>;
}

function Portal({ token, me, signOut }: { token: string; me: Member; signOut: () => void }) {
  const today = dhakaDate(Date.now());
  const [view, setView] = useState<View>('due');
  const [from, setFrom] = useState(today); const [to, setTo] = useState(addDays(today, 30));
  const [data, setData] = useState<Payload | null>(null); const [error, setError] = useState('');
  const [search, setSearch] = useState(''); const [mine, setMine] = useState(false);
  const [open, setOpen] = useState<TBooking | null>(null); const [pw, setPw] = useState(false);
  const [dueList, setDueList] = useState<TBooking[] | null>(null); const [todayList, setTodayList] = useState<TBooking[] | null>(null);
  const [updated, setUpdated] = useState<number | null>(null);

  const query = view === 'due' ? 'view=due' : view === 'today' ? `from=${today}&to=${today}` : view === 'upcoming' ? `from=${today}&to=${addDays(today, 14)}` : `from=${from}&to=${to}`;
  const load = useCallback((quiet = false) => {
    if (!quiet) setData(null);
    setError('');
    api<Payload>(`/api/team/bookings?${query}`, { token }).then(d => { setData(d); setUpdated(Date.now()); }).catch((e: Error) => setError(e.message));
    api<Payload>('/api/team/bookings?view=due', { token }).then(d => setDueList(d.bookings)).catch(() => {});
    api<Payload>(`/api/team/bookings?from=${today}&to=${today}`, { token }).then(d => setTodayList(d.bookings)).catch(() => {});
  }, [query, token, today]);
  useEffect(() => { load(); const t = setInterval(() => load(true), 60e3); return () => clearInterval(t); }, [load]);

  const shown = useMemo(() => (data?.bookings || []).filter(b => (!mine || b.assigned_to === me.id) &&
    (!search || [b.client_name, b.client_phone, b.client_email, b.service_name, b.referrer_label, b.client_institution].join(' ').toLowerCase().includes(search.toLowerCase()))), [data, mine, search, me.id]);
  const groups = useMemo(() => {
    const m = new Map<string, TBooking[]>();
    for (const b of shown) { const k = view === 'due' ? 'due' : dhakaDate(Date.parse(b.start_at)); m.set(k, [...(m.get(k) || []), b]); }
    return [...m.entries()];
  }, [shown, view]);
  const stats = [
    { k: 'due', label: 'Waiting for a call', value: dueList?.filter(b => b.follow_status !== 'follow_up').length, Icon: PhoneCall, tone: 'red', go: () => setView('due') },
    { k: 'cb', label: 'Call-backs due', value: dueList?.filter(b => b.follow_status === 'follow_up').length, Icon: AlarmClock, tone: 'violet', go: () => setView('due') },
    { k: 'today', label: 'Appointments today', value: todayList?.filter(b => b.status !== 'cancelled').length, Icon: CalendarDays, tone: 'blue', go: () => setView('today') },
    { k: 'mine', label: 'Assigned to me', value: dueList?.filter(b => b.assigned_to === me.id).length, Icon: UserCheck, tone: 'green', go: () => { setView('due'); setMine(true); } },
  ];
  const saved = (b: TBooking) => { setData(d => d && { ...d, bookings: d.bookings.map(x => x.id === b.id ? b : x) }); setOpen(b); load(true); };
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: 'numeric', hour12: false }).format(new Date()));

  return <div className="team-shell">
    <header className="team-bar">
      <Brand caption="Communication team"/>
      <div className="team-user">
        <Avatar name={me.full_name} size={36}/>
        <div><strong>{me.full_name}</strong><small>{me.email}</small></div>
        <button className="ghost-btn" onClick={() => setPw(true)} title="Change password"><KeyRound size={16}/></button>
        <button className="ghost-btn" onClick={signOut} title="Sign out"><LogOut size={16}/><span>Sign out</span></button>
      </div>
    </header>
    <main className="team-main">
      <div className="team-hello">
        <div><p className="eyebrow">{fmtDay(today)}</p><h1>Good {hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, {me.full_name.split(' ')[0]}</h1></div>
        <button className="secondary" onClick={() => load()}><RefreshCw size={15}/> Refresh{updated && <small> · {fmtTime(updated)}</small>}</button>
      </div>
      <div className="stat-grid">{stats.map(({ k, label, value, Icon, tone, go }) =>
        <button key={k} className={`stat ${tone}`} onClick={go}><span className="stat-icon"><Icon size={20}/></span><strong>{value ?? '–'}</strong><span>{label}</span></button>)}</div>

      <div className="team-controls">
        <div className="seg views">{([['due', 'To call', PhoneCall], ['today', 'Today', CalendarDays], ['upcoming', 'Next 14 days', ClipboardList], ['range', 'All dates', CalendarRange]] as const).map(([k, label, Icon]) =>
          <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}><Icon size={15}/>{label}{k === 'due' && dueList?.length ? <span className="count">{dueList.length}</span> : null}</button>)}</div>
        <div className="team-filters">
          {view === 'range' && <><input type="date" aria-label="From" value={from} onChange={e => setFrom(e.target.value)}/><input type="date" aria-label="To" value={to} onChange={e => setTo(e.target.value)}/></>}
          <span className="input-icon search"><Search size={16}/><input type="search" placeholder="Search client, phone, referrer…" value={search} onChange={e => setSearch(e.target.value)}/></span>
          <label className={`toggle ${mine ? 'on' : ''}`}><input type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)}/> Only mine</label>
        </div>
      </div>

      {view === 'due' && <p className="muted small hint">New bookings not yet contacted, clients who didn’t answer, and call-backs due in the next 24 hours.</p>}
      {error && <p className="alert">{error}</p>}
      {!data && !error && <div className="skeleton-list">{[0, 1, 2].map(i => <div key={i} className="skeleton"/>)}</div>}
      {data && !shown.length && <div className="empty-state"><CheckCircle2 size={34}/><h3>{view === 'due' ? 'All caught up' : 'No bookings here'}</h3><p>{view === 'due' ? 'Nobody is waiting for a call right now.' : 'Try another date range or clear the search.'}</p></div>}
      {groups.map(([day, list]) => <section key={day} className="team-day">
        {view !== 'due' && <h2>{fmtDay(day)}{day === today && <span className="today-dot">Today</span>}<small>{list.length} booking{list.length === 1 ? '' : 's'}</small></h2>}
        <ul className="team-list">{list.map(b => { const MI = MODE_ICON[b.mode]; return <li key={b.id} className={`tcard s-${b.follow_status} ${b.status === 'cancelled' ? 'off' : ''}`} tabIndex={0}
          onClick={() => setOpen(b)} onKeyDown={e => e.key === 'Enter' && setOpen(b)}>
          <div className="tc-when"><strong>{fmtTime(b.start_at)}</strong><small>{view === 'due' || view === 'range' ? fmtDay(dhakaDate(Date.parse(b.start_at)), { weekday: 'short', day: 'numeric', month: 'short' }) : `${b.duration_min} min`}</small></div>
          <Avatar name={b.client_name}/>
          <div className="tc-body">
            <div className="tc-name"><strong>{b.client_name}</strong>{b.client_institution && <small>{b.client_institution}</small>}</div>
            <div className="tc-meta"><span><MI size={14}/> {MODE[b.mode]}</span><span>{b.service_name}</span><span className="tc-phone"><Phone size={13}/> {b.client_phone}</span></div>
            <Referrer label={b.referrer_label}/>
          </div>
          <div className="tc-state">
            <span className={`pill f-${b.follow_status}`}>{FOLLOW[b.follow_status]}</span>
            {b.status === 'cancelled' && <span className="pill cancelled">Cancelled</span>}
            {b.follow_status === 'follow_up' && b.follow_up_at && <small className={Date.parse(b.follow_up_at) < Date.now() ? 'late' : ''}><AlarmClock size={13}/> {fmtDateTime(b.follow_up_at)}</small>}
            {b.assigned_name && <small><UserCheck size={13}/> {b.assigned_to === me.id ? 'You' : b.assigned_name}</small>}
          </div>
          <div className="tc-actions" onClick={e => e.stopPropagation()}>
            <a className="round-btn call" href={`tel:${b.client_phone}`} aria-label={`Call ${b.client_name}`} title="Call"><Phone size={18}/></a>
            <a className="round-btn wa" href={waLink(b.client_phone)} target="_blank" rel="noreferrer" aria-label={`WhatsApp ${b.client_name}`} title="WhatsApp"><MessageCircle size={18}/></a>
          </div>
        </li>; })}</ul>
      </section>)}
    </main>
    {open && <TeamDrawer token={token} me={me} booking={open} members={data?.members || []} onClose={() => setOpen(null)} onSaved={saved}/>}
    {pw && <PasswordDialog token={token} onClose={() => setPw(false)}/>}
  </div>;
}

function TeamDrawer({ token, me, booking: b, members, onClose, onSaved }: { token: string; me: Member; booking: TBooking; members: Member[]; onClose: () => void; onSaved: (b: TBooking) => void }) {
  const [log, setLog] = useState<Activity[] | null>(null);
  const [outcome, setOutcome] = useState(''); const [status, setStatus] = useState(''); const [callback, setCallback] = useState(toLocalInput(b.follow_up_at));
  const [note, setNote] = useState(''); const [assign, setAssign] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { setLog(null); api<{ activity: Activity[] }>(`/api/team/activity?booking_id=${b.id}`, { token }).then(r => setLog(r.activity)).catch(() => setLog([])); }, [b.id, token]);
  const callbackChanged = callback !== toLocalInput(b.follow_up_at);
  const dirty = !!(outcome || status || note.trim() || assign || callbackChanged);
  async function save(extra: Record<string, unknown> = {}) {
    setBusy(true); setError('');
    const body: Record<string, unknown> = { booking_id: b.id, ...extra };
    if (outcome && !('outcome' in extra)) body.outcome = outcome;
    if (status && !('follow_status' in extra)) body.follow_status = status;
    if (note.trim()) body.note = note.trim();
    if (assign && !('assign' in extra)) body.assign = assign;
    if (callbackChanged && !('follow_up_at' in extra)) body.follow_up_at = fromLocalInput(callback);
    try {
      const r = await api<{ booking: TBooking; activity: Activity[] }>('/api/team/update', { method: 'POST', token, body: JSON.stringify(body) });
      setLog(r.activity); onSaved(r.booking); setOutcome(''); setStatus(''); setNote(''); setAssign(''); setCallback(toLocalInput(r.booking.follow_up_at));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const firstName = b.client_name.split(' ')[0];
  const waText = `Hello ${firstName}, this is ${me.full_name} from Brilliancy Research about your ${b.service_name} appointment on ${fmtDateTime(b.start_at)}.`;
  return <div className="drawer-back" onClick={onClose}><aside className="drawer team-drawer" onClick={e => e.stopPropagation()} role="dialog" aria-label="Booking details">
    <button className="link close" onClick={onClose}>Close</button>
    <div className="td-head">
      <Avatar name={b.client_name} size={56}/>
      <div><h2>{b.client_name}</h2><p>{fmtDateTime(b.start_at)} · {b.duration_min} min</p>
        <div className="pills"><span className={`pill f-${b.follow_status}`}>{FOLLOW[b.follow_status]}</span><span className={`pill ${b.status}`}>{STATUS[b.status] || b.status}</span></div></div>
    </div>
    <div className={`ref-hero ${b.referrer_label === 'No one' ? 'none' : ''}`}><Award size={20}/><div><small>Referred by</small><b>{b.referrer_label === 'No one' ? 'No one (came directly)' : b.referrer_label}</b></div></div>
    <div className="quick big-quick">
      <a className="primary" href={`tel:${b.client_phone}`}><Phone size={16}/> Call {b.client_phone}</a>
      <a className="secondary" href={waLink(b.client_phone, waText)} target="_blank" rel="noreferrer"><MessageCircle size={16}/> WhatsApp</a>
      <a className="secondary" href={`mailto:${b.client_email}`}><Mail size={16}/> Email</a>
      {b.meet_link && <a className="secondary" href={b.meet_link} target="_blank" rel="noreferrer"><Video size={16}/> Meet</a>}
    </div>
    <dl className="facts">
      <div><dt>Service</dt><dd>{b.service_name}</dd></div><div><dt>Meeting</dt><dd>{MODE[b.mode]}</dd></div>
      <div><dt>Email</dt><dd>{b.client_email}</dd></div><div><dt>Institution</dt><dd>{b.client_institution || '—'}</dd></div>
      <div><dt>Phone</dt><dd>{b.client_phone}</dd></div><div><dt>Booked</dt><dd>{fmtDateTime(b.created_at)}</dd></div>
      <div><dt>Assigned to</dt><dd>{b.assigned_name || 'Nobody yet'}</dd></div><div><dt>Last contact</dt><dd>{b.last_contact_at ? ago(b.last_contact_at) : 'Not yet'}</dd></div>
    </dl>
    {b.client_note && <p className="quote">“{b.client_note}”</p>}

    <div className="log-form">
      <h3>Log a call or task</h3>
      <div className="outcomes" role="group" aria-label="Call outcome">
        {(['reached', 'no_answer', 'busy', 'whatsapp', 'email', 'wrong_number'] as const).map(k =>
          <button key={k} type="button" className={`chip ${outcome === k ? 'on' : ''}`} aria-pressed={outcome === k} onClick={() => setOutcome(outcome === k ? '' : k)}>
            {k === 'reached' ? <CheckCircle2 size={14}/> : k === 'no_answer' ? <PhoneMissed size={14}/> : null}{OUTCOME[k]}</button>)}
      </div>
      <div className="fields">
        <label>Status<select value={status} onChange={e => setStatus(e.target.value)}><option value="">Keep: {FOLLOW[b.follow_status]}</option>
          {Object.entries(FOLLOW).filter(([k]) => k !== b.follow_status).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Call back at<input type="datetime-local" value={callback} onChange={e => { setCallback(e.target.value); if (e.target.value && !status) setStatus('follow_up'); }}/><small>Bangladesh time</small></label>
        <label className="wide">Note<textarea rows={3} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} placeholder="What was discussed, what the client needs, next step…"/></label>
        <label>Assign<select value={assign} onChange={e => setAssign(e.target.value)}><option value="">Keep: {b.assigned_name || 'Nobody'}</option>
          {b.assigned_to !== me.id && <option value="me">Me ({me.full_name})</option>}
          {members.filter(m => m.id !== me.id && m.id !== b.assigned_to).map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
          {b.assigned_to && <option value="none">Nobody</option>}</select></label>
      </div>
      {error && <p className="alert">{error}</p>}
      <div className="actions">
        <button className="primary" disabled={busy || !dirty} onClick={() => save()}>{busy ? 'Saving…' : 'Save update'}</button>
        {b.follow_status !== 'done' && <button className="secondary" disabled={busy} onClick={() => save({ follow_status: 'done' })}><CheckCircle2 size={15}/> Mark done</button>}
      </div>
    </div>

    <div className="history">
      <h3><ClipboardList size={15}/> Activity</h3>
      {!log && <p className="muted small">Loading…</p>}
      {log && !log.length && <p className="muted small">No calls logged yet.</p>}
      {log && !!log.length && <ol className="timeline">{log.map(a => <li key={a.id}>
        <div><strong>{a.actor_name}</strong>{a.actor_type === 'admin' && <small> (admin)</small>} <small className="muted">· {ago(a.created_at)}</small></div>
        <div className="tl-tags">{a.outcome && <span className="chip static">{OUTCOME[a.outcome] || a.outcome}</span>}
          {a.follow_status && <span className={`pill f-${a.follow_status}`}>{FOLLOW[a.follow_status]}</span>}
          {a.follow_up_at && <small><AlarmClock size={12}/> {fmtDateTime(a.follow_up_at)}</small>}</div>
        {a.note && <p>{a.note}</p>}
      </li>)}</ol>}
    </div>
  </aside></div>;
}

function PasswordDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const [f, setF] = useState({ current: '', password: '', confirm: '' }); const [msg, setMsg] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(''); setMsg('');
    if (f.password !== f.confirm) { setErr('The new passwords do not match.'); return; }
    setBusy(true);
    try { await api('/api/team/password', { method: 'POST', token, body: JSON.stringify({ current: f.current, password: f.password }) }); setMsg('Password changed.'); setF({ current: '', password: '', confirm: '' }); }
    catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  }
  return <div className="drawer-back" onClick={onClose}><aside className="drawer" onClick={e => e.stopPropagation()} role="dialog" aria-label="Change password">
    <button className="link close" onClick={onClose}>Close</button>
    <h2>Change my password</h2>
    <form className="fields one" onSubmit={submit}>
      <label>Current password<input type="password" required autoComplete="current-password" value={f.current} onChange={e => setF({ ...f, current: e.target.value })}/></label>
      <label>New password<input type="password" minLength={10} required autoComplete="new-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })}/><small>At least 10 characters.</small></label>
      <label>Confirm new password<input type="password" minLength={10} required autoComplete="new-password" value={f.confirm} onChange={e => setF({ ...f, confirm: e.target.value })}/></label>
      {err && <p className="alert">{err}</p>}{msg && <p className="ok-msg">{msg}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
    </form>
  </aside></div>;
}
