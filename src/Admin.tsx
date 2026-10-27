import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { BarChart3, CalendarDays, Copy, History, Link2, LogOut, MessageCircle, RefreshCw, Settings2, Users } from 'lucide-react';
import Analytics from './Analytics';
import Brand from './Brand';
import { api, type Mode, type OffDay, type Service } from './lib/api';
import { addDays, DAY_NAMES, dhakaDate, fmtDateTime } from './lib/time';

type Booking = { id: string; service_name: string; duration_min: number; mode: Mode; start_at: string; end_at: string; status: string; client_name: string; client_phone: string; client_email: string;
  client_institution: string; client_note: string; referrer_label: string; referrer_code: string | null; referrer_source: string; meet_link: string | null; calendar_error: string | null; internal_note: string; created_at: string };
type Referrer = { code: string; full_name: string; designation: string; email: string | null; phone: string; notify: boolean; active: boolean };
type AdminRow = { id: string; email: string; full_name: string; active: boolean };
type SettingsPayload = { settings: Record<string, unknown> & { open_time: string; close_time: string; working_days: number[]; slot_step_min: number; min_notice_min: number; max_days_ahead: number; modes: Mode[]; office_address: string; calendar_id: string; notify_email: string };
  services: Service[]; off_days: OffDay[]; google: { connected: boolean; email: string | null; connected_at: string | null; last_ok_at: string | null; last_error: string | null; redirect_uri: string }; referrers: Referrer[]; admins?: AdminRow[] };
type ReportRow = { referrer_code: string | null; full_name: string | null; referrer_label: string; total: number; upcoming: number; completed: number; no_show: number; cancelled: number };
type Tab = 'bookings' | 'analytics' | 'referrals' | 'settings';
const STATUS: Record<string, string> = { calendar_pending: 'Calendar pending', confirmed: 'Confirmed', completed: 'Completed', no_show: 'No-show', cancelled: 'Cancelled' };
const MODE: Record<Mode, string> = { office: 'Office', meet: 'Meet', phone: 'Phone' };
const today = dhakaDate(Date.now());
const GOOGLE_MSG: Record<string, string> = { connected: 'Office Google Calendar connected.', denied: 'Google sign-in was cancelled.', invalid_state: 'The sign-in link expired. Try again.', expired: 'The sign-in link expired. Try again.',
  no_refresh_token: 'Google did not grant offline access. Remove the app in your Google Account → Security → Third-party access, then connect again.', missing_permission: 'Calendar permission was not granted. Tick both calendar permissions on the Google screen.', failed: 'Google sign-in failed. Try again.' };

const TOKEN_KEY = 'brilliancy-appointments-admin';
const readToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const writeToken = (t: string | null) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* private mode: session lasts until reload */ } };

export default function Admin() {
  const [token, setTokenState] = useState<string | null>(readToken);
  const [admin, setAdmin] = useState<{ id: string; full_name: string } | null>(null);
  const [authError, setAuthError] = useState('');
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const setToken = (t: string | null) => { writeToken(t); setTokenState(t); };
  useEffect(() => { api<{ needs_setup: boolean }>('/api/auth/setup-status').then(r => setNeedsSetup(r.needs_setup)).catch(() => setNeedsSetup(false)); }, []);
  useEffect(() => {
    if (!token) { setAdmin(null); return; }
    api<{ admin: { id: string; full_name: string } }>('/api/admin/me', { token }).then(r => setAdmin(r.admin)).catch((e: Error & { code?: string }) => {
      if (['ADMIN_REQUIRED', 'SESSION_EXPIRED', 'SIGN_IN_REQUIRED'].includes(e.code || '')) { setToken(null); setAuthError(e.code === 'SESSION_EXPIRED' ? e.message : ''); }
      else setAuthError(e.message);
    });
  }, [token]);
  if (needsSetup === null) return null;
  if (needsSetup && !token) return <Setup onDone={t => { setNeedsSetup(false); setToken(t); }}/>;
  if (!token || !admin) return <Login error={authError} onError={setAuthError} onToken={setToken}/>;
  return <Portal token={token} admin={admin} signOut={() => setToken(null)}/>;
}

function Shell({ children }: { children: ReactNode }) { return <div className="done-shell"><Brand caption="Appointments admin"/><div className="ticket">{children}</div></div>; }

function Login({ error, onError, onToken }: { error: string; onError: (e: string) => void; onToken: (t: string) => void }) {
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); onError('');
    try { onToken((await api<{ access_token: string }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) })).access_token); }
    catch (err) { onError((err as Error).message); } finally { setBusy(false); }
  }
  return <Shell><h1>Administrator sign-in</h1><p className="muted">Use the administrator email and password for this booking system.</p>
    <form onSubmit={submit} className="fields one">
      <label>Email<input type="email" autoComplete="username" value={u} onChange={e => setU(e.target.value)} required/></label>
      <label>Password<input type="password" autoComplete="current-password" value={p} onChange={e => setP(e.target.value)} required/></label>
      {error && <p className="alert" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form></Shell>;
}

function Setup({ onDone }: { onDone: (token: string) => void }) {
  const [f, setF] = useState({ setup_code: '', full_name: '', email: '', password: '', confirm: '' }); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault(); setError('');
    if (f.password !== f.confirm) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    try { onDone((await api<{ access_token: string }>('/api/auth/setup', { method: 'POST', body: JSON.stringify(f) })).access_token); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <Shell><h1>Create the first administrator</h1><p className="muted">This appears only once, while no administrator exists. Enter the setup code from the server settings (SETUP_CODE).</p>
    <form onSubmit={submit} className="fields one">
      <label>Setup code<input value={f.setup_code} onChange={e => setF({ ...f, setup_code: e.target.value })} required autoComplete="off"/></label>
      <label>Your name<input value={f.full_name} onChange={e => setF({ ...f, full_name: e.target.value })} required autoComplete="name"/></label>
      <label>Email<input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} required autoComplete="username"/></label>
      <label>Password<input type="password" minLength={10} value={f.password} onChange={e => setF({ ...f, password: e.target.value })} required autoComplete="new-password"/><small>At least 10 characters.</small></label>
      <label>Confirm password<input type="password" minLength={10} value={f.confirm} onChange={e => setF({ ...f, confirm: e.target.value })} required autoComplete="new-password"/></label>
      {error && <p className="alert" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create administrator'}</button>
    </form></Shell>;
}

function Portal({ token, admin, signOut }: { token: string; admin: { full_name: string }; signOut: () => void }) {
  const [tab, setTab] = useState<Tab>(() => new URLSearchParams(location.search).get('google') ? 'settings' : 'bookings');
  return <div className="admin-shell">
    <header className="admin-bar">
      <Brand caption="Appointments admin"/>
      <nav>
        {([['bookings', 'Bookings', CalendarDays], ['analytics', 'Analytics', BarChart3], ['referrals', 'Referrals', Users], ['settings', 'Settings', Settings2]] as const).map(([k, label, Icon]) =>
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}><Icon size={16}/>{label}</button>)}
      </nav>
      <div className="who"><span>{admin.full_name}</span><button className="link" onClick={signOut}><LogOut size={15}/> Sign out</button></div>
    </header>
    <main className="admin-main">
      {tab === 'bookings' && <Bookings token={token}/>}
      {tab === 'referrals' && <Referrals token={token}/>}
      {tab === 'analytics' && <Analytics token={token}/>}
      {tab === 'settings' && <SettingsTab token={token}/>}
    </main>
  </div>;
}

function useRange(days = 14) {
  const [from, setFrom] = useState(today); const [to, setTo] = useState(addDays(today, days));
  return { from, to, setFrom, setTo, picker: <div className="range"><label>From<input type="date" value={from} onChange={e => setFrom(e.target.value)}/></label><label>To<input type="date" value={to} onChange={e => setTo(e.target.value)}/></label></div> };
}
const csv = (rows: (string | number | null)[][], name: string) => {
  const text = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' })); a.download = name; a.click();
};

function Bookings({ token }: { token: string }) {
  const r = useRange();
  const [status, setStatus] = useState(''); const [search, setSearch] = useState('');
  const [rows, setRows] = useState<Booking[] | null>(null); const [error, setError] = useState(''); const [open, setOpen] = useState<Booking | null>(null);
  const load = () => { setRows(null); setError(''); api<{ bookings: Booking[] }>(`/api/admin/bookings?from=${r.from}&to=${r.to}${status ? '&status=' + status : ''}`, { token }).then(x => setRows(x.bookings)).catch((e: Error) => setError(e.message)); };
  useEffect(load, [r.from, r.to, status]);
  const shown = useMemo(() => (rows || []).filter(b => !search || [b.client_name, b.client_phone, b.client_email, b.referrer_label, b.service_name].join(' ').toLowerCase().includes(search.toLowerCase())), [rows, search]);
  const counts = useMemo(() => (rows || []).reduce((a, b) => ({ ...a, [b.status]: (a[b.status] || 0) + 1 }), {} as Record<string, number>), [rows]);
  return <section>
    <div className="toolbar">
      <h1>Bookings</h1>
      {r.picker}
      <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Status"><option value="">All statuses</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <input type="search" placeholder="Search name, phone, referrer…" value={search} onChange={e => setSearch(e.target.value)}/>
      <button className="secondary" onClick={load}><RefreshCw size={15}/> Refresh</button>
      <button className="secondary" disabled={!shown.length} onClick={() => csv([['Date & time', 'Service', 'Meeting', 'Status', 'Client', 'Phone', 'Email', 'Institution', 'Referred by', 'Referrer ID', 'Client note', 'Internal note', 'Booked at'],
        ...shown.map(b => [fmtDateTime(b.start_at), b.service_name, MODE[b.mode], STATUS[b.status], b.client_name, b.client_phone, b.client_email, b.client_institution, b.referrer_label, b.referrer_code, b.client_note, b.internal_note, fmtDateTime(b.created_at)])], `bookings-${r.from}-to-${r.to}.csv`)}>Export CSV</button>
    </div>
    {rows && <p className="muted">{rows.length} bookings · {counts.confirmed || 0} confirmed · {counts.calendar_pending || 0} calendar pending · {counts.completed || 0} completed · {counts.no_show || 0} no-show · {counts.cancelled || 0} cancelled</p>}
    {error && <p className="alert">{error}</p>}
    {!rows && !error && <p className="muted">Loading…</p>}
    {rows && !shown.length && <p className="empty">No bookings in this range. Share the booking page to get started.</p>}
    {!!shown.length && <div className="table-wrap"><table>
      <thead><tr><th>When</th><th>Client</th><th>Service</th><th>Meeting</th><th>Referred by</th><th>Status</th></tr></thead>
      <tbody>{shown.map(b => <tr key={b.id} onClick={() => setOpen(b)} tabIndex={0} onKeyDown={e => e.key === 'Enter' && setOpen(b)}>
        <td>{fmtDateTime(b.start_at)}</td><td><strong>{b.client_name}</strong><br/><small>{b.client_phone}</small></td><td>{b.service_name}</td><td>{MODE[b.mode]}</td><td>{b.referrer_label}</td>
        <td><span className={`pill ${b.status}`}>{STATUS[b.status]}</span>{b.calendar_error && <small className="warn" title={b.calendar_error}>Calendar issue</small>}</td>
      </tr>)}</tbody></table></div>}
    {open && <BookingDrawer token={token} booking={open} onClose={() => setOpen(null)} onSaved={b => { setRows(rows => rows?.map(x => x.id === b.id ? { ...x, ...b } : x) || null); setOpen(o => o && { ...o, ...b }); }}/>}
  </section>;
}

function BookingDrawer({ token, booking: b, onClose, onSaved }: { token: string; booking: Booking; onClose: () => void; onSaved: (b: Partial<Booking> & { id: string }) => void }) {
  const [note, setNote] = useState(b.internal_note); const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [confirmCancel, setConfirmCancel] = useState(false);
  const update = async (body: Record<string, unknown>, label: string) => {
    setBusy(label); setError('');
    try { const r = await api<{ booking: Booking }>('/api/admin/bookings/update', { method: 'POST', token, body: JSON.stringify({ id: b.id, ...body }) }); onSaved(r.booking); setConfirmCancel(false); }
    catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  const active = ['confirmed', 'calendar_pending'].includes(b.status);
  const [history, setHistory] = useState<{ id: string; start_at: string; service_name: string; status: string }[] | null>(null);
  useEffect(() => {
    setHistory(null);
    api<{ bookings: { id: string; start_at: string; service_name: string; status: string }[] }>(`/api/admin/client-history?phone=${encodeURIComponent(b.client_phone)}&email=${encodeURIComponent(b.client_email)}`, { token })
      .then(r => setHistory(r.bookings)).catch(() => setHistory([]));
  }, [b.id]);
  const wa = b.client_phone.replace(/\D/g, '').replace(/^0/, '880');
  const waText = encodeURIComponent(`Hello ${b.client_name.split(' ')[0]}, this is Brilliancy Research about your ${b.service_name} appointment on ${fmtDateTime(b.start_at)}.`);
  return <div className="drawer-back" onClick={onClose}><aside className="drawer" onClick={e => e.stopPropagation()} role="dialog" aria-label="Booking details">
    <button className="link close" onClick={onClose}>Close</button>
    <span className={`pill ${b.status}`}>{STATUS[b.status]}</span>
    <h2>{b.client_name}</h2>
    <p className="big">{fmtDateTime(b.start_at)} · {b.duration_min} min</p>
    <dl className="facts">
      <div><dt>Service</dt><dd>{b.service_name}</dd></div><div><dt>Meeting</dt><dd>{MODE[b.mode]}{b.meet_link && <> · <a href={b.meet_link} target="_blank" rel="noreferrer">Meet link</a></>}</dd></div>
      <div><dt>Phone</dt><dd><a href={`tel:${b.client_phone}`}>{b.client_phone}</a></dd></div><div><dt>Email</dt><dd><a href={`mailto:${b.client_email}`}>{b.client_email}</a></dd></div>
      <div><dt>Institution</dt><dd>{b.client_institution || '—'}</dd></div><div><dt>Referred by</dt><dd>{b.referrer_label}{b.referrer_code && <small> · {b.referrer_code}</small>}</dd></div>
      <div><dt>Booked</dt><dd>{fmtDateTime(b.created_at)}</dd></div>
    </dl>
    <div className="quick">
      <a className="secondary" href={`https://wa.me/${wa}?text=${waText}`} target="_blank" rel="noreferrer"><MessageCircle size={15}/> WhatsApp</a>
      <a className="secondary" href={`tel:${b.client_phone}`}>Call</a>
      <a className="secondary" href={`mailto:${b.client_email}`}>Email</a>
    </div>
    {b.client_note && <p className="quote">“{b.client_note}”</p>}
    <div className="history">
      <h3><History size={15}/> Client history</h3>
      {!history && <p className="muted small">Loading…</p>}
      {history && history.length <= 1 && <p className="muted small">First booking from this client.</p>}
      {history && history.length > 1 && <><p className="small"><strong>{history.length} bookings</strong> · {history.filter(h => h.status === 'completed').length} completed · {history.filter(h => h.status === 'no_show').length} no-show</p>
        <ul className="plain small">{history.filter(h => h.id !== b.id).slice(0, 6).map(h => <li key={h.id}>{fmtDateTime(h.start_at)} · {h.service_name} <span className={`pill ${h.status}`}>{STATUS[h.status]}</span></li>)}</ul></>}
    </div>
    {b.calendar_error && <p className="alert">Google Calendar: {b.calendar_error} {b.status === 'calendar_pending' && <button className="link" disabled={!!busy} onClick={() => update({ status: 'retry_calendar' }, 'retry')}>Retry now</button>}</p>}
    <label>Internal note<textarea rows={3} value={note} onChange={e => setNote(e.target.value)}/></label>
    <button className="secondary" disabled={!!busy || note === b.internal_note} onClick={() => update({ internal_note: note }, 'note')}>{busy === 'note' ? 'Saving…' : 'Save note'}</button>
    {(active || ['completed', 'no_show'].includes(b.status)) && <div className="actions">
      {b.status !== 'completed' && <button className="primary" disabled={!!busy} onClick={() => update({ status: 'completed' }, 'completed')}>Mark completed</button>}
      {b.status !== 'no_show' && <button className="secondary" disabled={!!busy} onClick={() => update({ status: 'no_show' }, 'no_show')}>Mark no-show</button>}
      {active && !confirmCancel && <button className="danger" disabled={!!busy} onClick={() => setConfirmCancel(true)}>Cancel appointment</button>}
    </div>}
    {confirmCancel && <div className="confirm-box"><p>Cancel this appointment? The client is emailed and the calendar event is removed.</p>
      <button className="danger" disabled={!!busy} onClick={() => update({ status: 'cancelled' }, 'cancel')}>{busy === 'cancel' ? 'Cancelling…' : 'Yes, cancel it'}</button>
      <button className="link" onClick={() => setConfirmCancel(false)}>Keep it</button></div>}
    {error && <p className="alert">{error}</p>}
  </aside></div>;
}

function Referrals({ token }: { token: string }) {
  const r = useRange(0);
  const [from, setFrom] = useState(today.slice(0, 8) + '01');
  const [rows, setRows] = useState<ReportRow[] | null>(null); const [error, setError] = useState('');
  const [refs, setRefs] = useState<Referrer[]>([]); const [copied, setCopied] = useState('');
  useEffect(() => { setRows(null); api<{ rows: ReportRow[] }>(`/api/admin/referrals?from=${from}&to=${r.to}`, { token }).then(x => setRows(x.rows)).catch((e: Error) => setError(e.message)); }, [from, r.to]);
  useEffect(() => { api<SettingsPayload>('/api/admin/settings', { token }).then(s => setRefs(s.referrers)).catch(() => {}); }, []);
  const link = (code: string) => `${location.origin}/?ref=${encodeURIComponent(code)}`;
  const copy = (code: string) => navigator.clipboard.writeText(link(code)).then(() => { setCopied(code); setTimeout(() => setCopied(''), 1500); });
  return <section>
    <div className="toolbar"><h1>Referrals</h1>
      <div className="range"><label>From<input type="date" value={from} onChange={e => setFrom(e.target.value)}/></label><label>To<input type="date" value={r.to} onChange={e => r.setTo(e.target.value)}/></label></div>
      <button className="secondary" disabled={!rows?.length} onClick={() => csv([['Referred by', 'Employee ID', 'Total', 'Upcoming', 'Completed', 'No-show', 'Cancelled'], ...rows!.map(x => [x.referrer_label, x.referrer_code, x.total, x.upcoming, x.completed, x.no_show, x.cancelled])], `referrals-${from}-to-${r.to}.csv`)}>Export CSV</button>
    </div>
    <p className="muted">Counts by appointment date. Completed appointments are the number that matters for incentives.</p>
    {error && <p className="alert">{error}</p>}
    {rows && !rows.length && <p className="empty">No bookings with a referrer in this range yet.</p>}
    {!!rows?.length && <div className="table-wrap"><table><thead><tr><th>Referred by</th><th>ID</th><th>Total</th><th>Upcoming</th><th>Completed</th><th>No-show</th><th>Cancelled</th></tr></thead>
      <tbody>{rows.map((x, i) => <tr key={i}><td><strong>{x.referrer_label}</strong></td><td>{x.referrer_code || '—'}</td><td>{x.total}</td><td>{x.upcoming}</td><td><strong>{x.completed}</strong></td><td>{x.no_show}</td><td>{x.cancelled}</td></tr>)}</tbody></table></div>}
    <h2 className="sub"><Link2 size={18}/> Referral links</h2>
    <p className="muted">Each employee shares their own link. Clients who open it have the referrer filled in automatically.</p>
    <div className="table-wrap"><table><thead><tr><th>Employee</th><th>ID</th><th>Link</th></tr></thead>
      <tbody>{refs.filter(x => x.active).map(x => <tr key={x.code}><td>{x.full_name}<br/><small>{x.designation}</small></td><td>{x.code}</td>
        <td><code>{link(x.code)}</code> <button className="link" onClick={() => copy(x.code)}><Copy size={14}/> {copied === x.code ? 'Copied' : 'Copy'}</button></td></tr>)}</tbody></table></div>
  </section>;
}

function SettingsTab({ token }: { token: string }) {
  const [data, setData] = useState<SettingsPayload | null>(null); const [error, setError] = useState(''); const [msg, setMsg] = useState(() => GOOGLE_MSG[new URLSearchParams(location.search).get('google') || ''] || '');
  const [form, setForm] = useState<SettingsPayload['settings'] | null>(null); const [busy, setBusy] = useState('');
  const load = () => api<SettingsPayload>('/api/admin/settings', { token }).then(d => { setData(d); setForm(d.settings); }).catch((e: Error) => setError(e.message));
  useEffect(() => { load(); if (location.search) history.replaceState(null, '', '/admin'); }, []);
  const post = async (path: string, body: unknown, label: string, after?: () => void) => {
    setBusy(label); setError(''); setMsg('');
    try { await api(path, { method: 'POST', token, body: JSON.stringify(body) }); await load(); setMsg('Saved.'); after?.(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  if (!data || !form) return <section><h1>Settings</h1>{error ? <p className="alert">{error}</p> : <p className="muted">Loading…</p>}</section>;
  const g = data.google;
  return <section className="settings">
    <h1>Settings</h1>
    {msg && <p className="notice">{msg}</p>}{error && <p className="alert">{error}</p>}

    <div className="card">
      <h2>Office Google Calendar</h2>
      {g.connected ? <><p>Connected as <strong>{g.email}</strong>{g.connected_at && <> since {fmtDateTime(g.connected_at)}</>}. Clients only see times that are free on this calendar, and every booking is added to it.</p>
          {g.last_error && <p className="alert">{g.last_error}</p>}
          <button className="secondary" disabled={!!busy} onClick={() => confirm('Disconnect the office calendar? New bookings will wait as "Calendar pending" until it is reconnected.') && post('/api/admin/google/disconnect', {}, 'g')}>Disconnect</button></>
        : <><p className="alert">Not connected. Bookings still work, but nothing is checked against or written to Google Calendar until an administrator connects the office Google account.</p>
          {g.last_error && <p className="muted">{g.last_error}</p>}
          <button className="primary" disabled={!!busy} onClick={async () => { setBusy('g'); try { location.href = (await api<{ url: string }>('/api/admin/google/start', { method: 'POST', token, body: '{}' })).url; } catch (e) { setError((e as Error).message); setBusy(''); } }}>Connect office Google Calendar</button>
          <p className="muted small">Sign in with the office Google account (the one whose calendar should hold appointments). Redirect URI for Google Cloud: <code>{g.redirect_uri}</code></p></>}
    </div>

    <form className="card" onSubmit={e => { e.preventDefault(); post('/api/admin/settings', form, 's'); }}>
      <h2>Booking rules</h2>
      <div className="fields">
        <label>Opens<input type="time" value={form.open_time} onChange={e => setForm({ ...form, open_time: e.target.value })}/></label>
        <label>Closes<input type="time" value={form.close_time} onChange={e => setForm({ ...form, close_time: e.target.value })}/><small>Appointments must end by this time.</small></label>
        <label>Slot step (minutes)<input type="number" min={5} max={240} value={form.slot_step_min} onChange={e => setForm({ ...form, slot_step_min: +e.target.value })}/></label>
        <label>Minimum notice (minutes)<input type="number" min={0} max={10080} value={form.min_notice_min} onChange={e => setForm({ ...form, min_notice_min: +e.target.value })}/></label>
        <label>Days bookable ahead<input type="number" min={1} max={180} value={form.max_days_ahead} onChange={e => setForm({ ...form, max_days_ahead: +e.target.value })}/></label>
        <label>Office notification email<input type="email" value={form.notify_email} onChange={e => setForm({ ...form, notify_email: e.target.value })}/></label>
        <label className="wide">Office address<input value={form.office_address} onChange={e => setForm({ ...form, office_address: e.target.value })}/></label>
        <label>Google calendar ID<input value={form.calendar_id} onChange={e => setForm({ ...form, calendar_id: e.target.value })}/><small>Usually “primary”.</small></label>
      </div>
      <fieldset><legend>Working days</legend>{DAY_NAMES.map((d, i) => <label key={d} className="check"><input type="checkbox" checked={form.working_days.includes(i)} onChange={e => setForm({ ...form, working_days: e.target.checked ? [...form.working_days, i] : form.working_days.filter(x => x !== i) })}/>{d}</label>)}</fieldset>
      <fieldset><legend>Meeting types offered</legend>{(['office', 'meet', 'phone'] as Mode[]).map(m => <label key={m} className="check"><input type="checkbox" checked={form.modes.includes(m)} onChange={e => setForm({ ...form, modes: e.target.checked ? [...form.modes, m] : form.modes.filter(x => x !== m) })}/>{{ office: 'In office', meet: 'Google Meet', phone: 'Phone call' }[m]}</label>)}</fieldset>
      <button className="primary" disabled={busy === 's'}>{busy === 's' ? 'Saving…' : 'Save rules'}</button>
    </form>

    <div className="card">
      <h2>Services</h2>
      <ServiceEditor services={data.services} busy={!!busy} onSave={s => post('/api/admin/services', s, 'svc')}/>
    </div>

    <div className="card">
      <h2>Office off days</h2>
      <p className="muted">Holidays and closures. Fridays are already closed by the working-days rule.</p>
      {data.off_days.length ? <ul className="plain">{data.off_days.map(o => <li key={o.id}>{o.from_date}{o.to_date !== o.from_date && ` → ${o.to_date}`} {o.reason && <span className="muted">· {o.reason}</span>} <button className="link" disabled={!!busy} onClick={() => post('/api/admin/off-days', { id: o.id, delete: true }, 'off')}>Remove</button></li>)}</ul> : <p className="muted">No upcoming off days.</p>}
      <OffDayForm busy={!!busy} onSave={o => post('/api/admin/off-days', o, 'off')}/>
    </div>

    <div className="card">
      <h2>Referring employees</h2>
      <p className="muted">The “Who referred you?” list on the booking page. Inactive employees are hidden from clients but keep their history. Email is used only to notify the employee when their referral books.</p>
      <ReferrerEditor referrers={data.referrers} busy={!!busy} onSave={r => post('/api/admin/referrers', r, 'ref')}/>
      <BulkReferrers busy={!!busy} onImport={rows => post('/api/admin/referrers/bulk', { rows }, 'bulk')}/>
    </div>

    <div className="card">
      <h2>Administrators</h2>
      <p className="muted">People who can sign in to this admin portal.</p>
      <AdminEditor admins={data.admins || []} busy={!!busy} onSave={a => post('/api/admin/admins', a, 'adm')}/>
      <PasswordForm busy={!!busy} onSave={b => post('/api/admin/password', b, 'pw')}/>
    </div>
  </section>;
}

function ServiceEditor({ services, busy, onSave }: { services: Service[]; busy: boolean; onSave: (s: Partial<Service>) => void }) {
  const blank = { name: '', description: '', duration_min: 30, sort_order: 100, active: true };
  const [edit, setEdit] = useState<Partial<Service> | null>(null);
  return <>
    <ul className="plain">{services.map(s => <li key={s.id} className={s.active ? '' : 'off'}><strong>{s.name}</strong> · {s.duration_min} min {!s.active && <span className="muted">· hidden</span>} <button className="link" onClick={() => setEdit(s)}>Edit</button></li>)}</ul>
    {!edit && <button className="secondary" onClick={() => setEdit(blank)}>Add service</button>}
    {edit && <form className="inline-form" onSubmit={e => { e.preventDefault(); onSave(edit); setEdit(null); }}>
      <div className="fields">
        <label>Name<input required value={edit.name || ''} onChange={e => setEdit({ ...edit, name: e.target.value })}/></label>
        <label>Duration (minutes)<input type="number" min={15} max={480} step={5} required value={edit.duration_min || 30} onChange={e => setEdit({ ...edit, duration_min: +e.target.value })}/></label>
        <label className="wide">Description<input value={edit.description || ''} onChange={e => setEdit({ ...edit, description: e.target.value })}/></label>
        <label>Order<input type="number" value={edit.sort_order ?? 100} onChange={e => setEdit({ ...edit, sort_order: +e.target.value })}/></label>
        <label className="check self">Shown to clients<input type="checkbox" checked={edit.active !== false} onChange={e => setEdit({ ...edit, active: e.target.checked })}/></label>
      </div>
      <button className="primary" disabled={busy}>Save service</button> <button type="button" className="link" onClick={() => setEdit(null)}>Cancel</button>
    </form>}
  </>;
}
function OffDayForm({ busy, onSave }: { busy: boolean; onSave: (o: { from: string; to: string; reason: string }) => void }) {
  const [o, setO] = useState({ from: today, to: today, reason: '' });
  return <form className="inline-form" onSubmit={e => { e.preventDefault(); onSave(o); }}><div className="fields">
    <label>From<input type="date" required value={o.from} onChange={e => setO({ ...o, from: e.target.value, to: e.target.value > o.to ? e.target.value : o.to })}/></label>
    <label>To<input type="date" required value={o.to} min={o.from} onChange={e => setO({ ...o, to: e.target.value })}/></label>
    <label className="wide">Reason<input value={o.reason} onChange={e => setO({ ...o, reason: e.target.value })} placeholder="Eid holiday"/></label></div>
    <button className="secondary" disabled={busy}>Add off days</button></form>;
}
function ReferrerEditor({ referrers, busy, onSave }: { referrers: Referrer[]; busy: boolean; onSave: (r: Referrer) => void }) {
  const blank: Referrer = { code: '', full_name: '', designation: '', email: '', phone: '', notify: true, active: true };
  const [edit, setEdit] = useState<Referrer | null>(null); const [isNew, setIsNew] = useState(false);
  return <>
    <div className="table-wrap"><table><thead><tr><th>Name</th><th>ID</th><th>Designation</th><th>Notify</th><th></th></tr></thead>
      <tbody>{referrers.map(r => <tr key={r.code} className={r.active ? '' : 'off'}><td>{r.full_name}{!r.active && <small className="muted"> · inactive</small>}</td><td>{r.code}</td><td>{r.designation}</td><td>{r.notify && r.email ? 'Email' : '—'}</td><td><button className="link" onClick={() => { setEdit(r); setIsNew(false); }}>Edit</button></td></tr>)}</tbody></table></div>
    {!edit && <button className="secondary" onClick={() => { setEdit(blank); setIsNew(true); }}>Add employee</button>}
    {edit && <form className="inline-form" onSubmit={e => { e.preventDefault(); onSave(edit); setEdit(null); }}><div className="fields">
      <label>Employee ID<input required pattern="[A-Za-z0-9-]{2,30}" readOnly={!isNew} value={edit.code} onChange={e => setEdit({ ...edit, code: e.target.value.trim() })}/></label>
      <label>Full name<input required value={edit.full_name} onChange={e => setEdit({ ...edit, full_name: e.target.value })}/></label>
      <label>Designation<input value={edit.designation} onChange={e => setEdit({ ...edit, designation: e.target.value })}/></label>
      <label>Email<input type="email" value={edit.email || ''} onChange={e => setEdit({ ...edit, email: e.target.value })}/></label>
      <label>Phone<input value={edit.phone} onChange={e => setEdit({ ...edit, phone: e.target.value })}/></label>
      <label className="check self">Email them when a referral books<input type="checkbox" checked={edit.notify} onChange={e => setEdit({ ...edit, notify: e.target.checked })}/></label>
      <label className="check self">Shown on booking page<input type="checkbox" checked={edit.active} onChange={e => setEdit({ ...edit, active: e.target.checked })}/></label></div>
      <button className="primary" disabled={busy}>Save employee</button> <button type="button" className="link" onClick={() => setEdit(null)}>Cancel</button></form>}
  </>;
}

/** Paste rows copied from Excel/Sheets (tab-separated) or CSV: ID, Name, Designation, Email, Phone. */
function BulkReferrers({ busy, onImport }: { busy: boolean; onImport: (rows: Partial<Referrer>[]) => void }) {
  const [open, setOpen] = useState(false); const [text, setText] = useState('');
  const rows = useMemo(() => text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => l.includes('\t') ? l.split('\t') : l.split(','))
    .map(c => c.map(x => x.trim().replace(/^"|"$/g, ''))).filter(c => c[0] && !/^(employee )?id$/i.test(c[0]))
    .map(([code, full_name, designation = '', email = '', phone = '']) => ({ code, full_name, designation, email, phone })), [text]);
  if (!open) return <button className="secondary" onClick={() => setOpen(true)}>Bulk add from a spreadsheet</button>;
  return <div className="inline-form">
    <label>Paste rows: Employee ID, Name, Designation, Email, Phone (copy straight from Excel or Google Sheets)
      <textarea rows={6} value={text} onChange={e => setText(e.target.value)} placeholder={'BR21510926\tAziz Ahmed\tCommunication\tname@example.com\t017…'}/></label>
    <p className="muted small">{rows.length ? `${rows.length} employee${rows.length === 1 ? '' : 's'} ready. Existing IDs are updated, new IDs are added; nothing is deleted.` : 'Nothing pasted yet.'}</p>
    <button className="primary" disabled={busy || !rows.length} onClick={() => { onImport(rows); setText(''); setOpen(false); }}>Import {rows.length || ''} employees</button>{' '}
    <button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button>
  </div>;
}
function AdminEditor({ admins, busy, onSave }: { admins: AdminRow[]; busy: boolean; onSave: (a: Record<string, unknown>) => void }) {
  const [edit, setEdit] = useState<{ email: string; full_name: string; password: string; active: boolean; isNew: boolean } | null>(null);
  return <>
    <ul className="plain">{admins.map(a => <li key={a.id} className={a.active ? '' : 'off'}><strong>{a.full_name}</strong> · {a.email}{!a.active && <span className="muted"> · inactive</span>}
      <button className="link" onClick={() => setEdit({ email: a.email, full_name: a.full_name, password: '', active: a.active, isNew: false })}>Edit</button></li>)}</ul>
    {!edit && <button className="secondary" onClick={() => setEdit({ email: '', full_name: '', password: '', active: true, isNew: true })}>Add administrator</button>}
    {edit && <form className="inline-form" onSubmit={e => { e.preventDefault(); onSave(edit); setEdit(null); }}><div className="fields">
      <label>Email<input type="email" required readOnly={!edit.isNew} value={edit.email} onChange={e => setEdit({ ...edit, email: e.target.value })}/></label>
      <label>Name<input required value={edit.full_name} onChange={e => setEdit({ ...edit, full_name: e.target.value })}/></label>
      <label>{edit.isNew ? 'Password' : 'New password (optional)'}<input type="password" minLength={10} required={edit.isNew} autoComplete="new-password" value={edit.password} onChange={e => setEdit({ ...edit, password: e.target.value })}/><small>At least 10 characters. Share it with them privately.</small></label>
      {!edit.isNew && <label className="check self">Can sign in<input type="checkbox" checked={edit.active} onChange={e => setEdit({ ...edit, active: e.target.checked })}/></label>}
    </div><button className="primary" disabled={busy}>Save administrator</button> <button type="button" className="link" onClick={() => setEdit(null)}>Cancel</button></form>}
  </>;
}
function PasswordForm({ busy, onSave }: { busy: boolean; onSave: (b: { current: string; password: string }) => void }) {
  const [open, setOpen] = useState(false); const [f, setF] = useState({ current: '', password: '', confirm: '' }); const [err, setErr] = useState('');
  if (!open) return <p><button className="link" onClick={() => setOpen(true)}>Change my password</button></p>;
  return <form className="inline-form" onSubmit={e => { e.preventDefault(); if (f.password !== f.confirm) { setErr('The new passwords do not match.'); return; } onSave({ current: f.current, password: f.password }); setOpen(false); setF({ current: '', password: '', confirm: '' }); }}>
    <div className="fields">
      <label>Current password<input type="password" required autoComplete="current-password" value={f.current} onChange={e => setF({ ...f, current: e.target.value })}/></label>
      <label>New password<input type="password" minLength={10} required autoComplete="new-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })}/></label>
      <label>Confirm new password<input type="password" minLength={10} required autoComplete="new-password" value={f.confirm} onChange={e => setF({ ...f, confirm: e.target.value })}/></label>
    </div>{err && <p className="alert">{err}</p>}
    <button className="primary" disabled={busy}>Change password</button> <button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button></form>;
}
