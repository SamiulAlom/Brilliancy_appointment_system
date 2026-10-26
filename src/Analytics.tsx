import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RefreshCw, Table2 } from 'lucide-react';
import { api, type Mode } from './lib/api';
import { addDays, at, dhakaDate } from './lib/time';

type Row = { id: string; service_name: string; mode: Mode; start_at: string; status: string; client_name: string; client_phone: string; client_email: string;
  client_institution: string; referrer_label: string; created_at: string };
const today = dhakaDate(Date.now());
const MODE: Record<Mode, string> = { office: 'In office', meet: 'Google Meet', phone: 'Phone call' };
const STATUS: Record<string, string> = { confirmed: 'Upcoming / confirmed', calendar_pending: 'Calendar pending', completed: 'Completed', no_show: 'No-show', cancelled: 'Cancelled' };
const DAYS = [6, 0, 1, 2, 3, 4, 5]; // Saturday first (office week)
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RAMP = ['#fdecec', '#f9c3c3', '#f08b8b', '#dc4545', '#c91414', '#8f0d0d']; // one hue, light → dark
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const fmtN = (n: number) => n.toLocaleString('en-US');
const dhakaParts = (iso: string) => { const d = new Date(Date.parse(iso) + 6 * 3600e3); return { day: d.getUTCDay(), hour: d.getUTCHours(), date: dhakaDate(Date.parse(iso)) }; };

/** One shared tooltip for every chart: value first, label second. */
function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; value: string; label: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const show = (e: { clientX: number; clientY: number } | null, value: string, label: string, el?: Element) => {
    const box = root.current?.getBoundingClientRect(); if (!box) return;
    const r = el?.getBoundingClientRect();
    const x = e ? e.clientX : r ? r.left + r.width / 2 : 0, y = e ? e.clientY : r ? r.top : 0;
    setTip({ x: x - box.left, y: y - box.top, value, label });
  };
  const node = tip && <div className="viz-tip" style={{ left: tip.x, top: tip.y }} role="status"><strong>{tip.value}</strong><span>{tip.label}</span></div>;
  return { root, show, hide: () => setTip(null), node };
}
type Tip = ReturnType<typeof useTip>;

export default function Analytics({ token }: { token: string }) {
  const [preset, setPreset] = useState('90');
  const [from, setFrom] = useState(addDays(today, -89)); const [to, setTo] = useState(addDays(today, 30));
  const [rows, setRows] = useState<Row[] | null>(null); const [error, setError] = useState('');
  const [tables, setTables] = useState(false);
  const tip = useTip();
  const choose = (p: string) => {
    setPreset(p);
    if (p === '30') { setFrom(addDays(today, -29)); setTo(addDays(today, 14)); }
    if (p === '90') { setFrom(addDays(today, -89)); setTo(addDays(today, 30)); }
    if (p === '365') { setFrom(addDays(today, -364)); setTo(addDays(today, 30)); }
  };
  const load = () => { setRows(null); setError(''); api<{ bookings: Row[] }>(`/api/admin/bookings?from=${from}&to=${to}`, { token }).then(r => setRows(r.bookings)).catch((e: Error) => setError(e.message)); };
  useEffect(load, [from, to]);

  const a = useMemo(() => {
    if (!rows) return null;
    const live = rows.filter(r => r.status !== 'cancelled');
    const done = rows.filter(r => r.status === 'completed').length, noShow = rows.filter(r => r.status === 'no_show').length;
    const cancelled = rows.length - live.length;
    const upcoming = rows.filter(r => ['confirmed', 'calendar_pending'].includes(r.status) && Date.parse(r.start_at) > Date.now()).length;
    const key = (r: Row) => r.client_phone || r.client_email;
    const perClient = new Map<string, number>(); rows.forEach(r => perClient.set(key(r), (perClient.get(key(r)) || 0) + 1));
    const returning = [...perClient.values()].filter(n => n > 1).length;
    const count = (list: Row[], f: (r: Row) => string) => { const m = new Map<string, number>(); list.forEach(r => { const k = f(r) || '—'; m.set(k, (m.get(k) || 0) + 1); }); return [...m.entries()].sort((x, y) => y[1] - x[1]); };
    // Time series: per day, or per week when the range is long.
    const span = Math.round((at(to, '00:00') - at(from, '00:00')) / 86400e3) + 1, weekly = span > 62;
    const buckets: { key: string; label: string; n: number }[] = [];
    for (let d = from; d <= to; d = addDays(d, weekly ? 7 : 1)) buckets.push({ key: d, label: d, n: 0 });
    live.forEach(r => { const d = dhakaParts(r.start_at).date; const i = weekly ? Math.floor((at(d, '00:00') - at(from, '00:00')) / (7 * 86400e3)) : buckets.findIndex(b => b.key === d); if (buckets[i]) buckets[i].n++; });
    const heat = new Map<string, number>(); live.forEach(r => { const p = dhakaParts(r.start_at); heat.set(`${p.day}-${p.hour}`, (heat.get(`${p.day}-${p.hour}`) || 0) + 1); });
    const institutions = count(live.filter(r => r.client_institution), r => r.client_institution.trim());
    return { total: rows.length, live: live.length, done, noShow, cancelled, upcoming, clients: perClient.size, returning, weekly, buckets, heat,
      byService: count(live, r => r.service_name.startsWith('Other: ') ? 'Other (typed by client)' : r.service_name),
      otherTyped: count(live.filter(r => r.service_name.startsWith('Other: ')), r => r.service_name.slice(7)),
      byMode: count(live, r => MODE[r.mode]), byRef: count(live, r => r.referrer_label === '—' ? 'No referrer' : r.referrer_label),
      byStatus: count(rows, r => STATUS[r.status] || r.status), institutions };
  }, [rows, from, to]);

  return <section className="analytics" ref={tip.root}>
    <div className="toolbar">
      <h1>Client analysis</h1>
      <div className="seg" role="group" aria-label="Period">
        {[['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last 12 months'], ['custom', 'Custom']].map(([k, l]) =>
          <button key={k} className={preset === k ? 'on' : ''} onClick={() => choose(k)}>{l}</button>)}
      </div>
      {preset === 'custom' && <div className="range"><label>From<input type="date" value={from} onChange={e => setFrom(e.target.value)}/></label><label>To<input type="date" value={to} onChange={e => setTo(e.target.value)}/></label></div>}
      <button className="secondary" onClick={load}><RefreshCw size={15}/> Refresh</button>
      <button className="secondary" aria-pressed={tables} onClick={() => setTables(t => !t)}><Table2 size={15}/> {tables ? 'Show charts' : 'Show as tables'}</button>
    </div>
    <p className="muted">By appointment date, {from} to {to}. Cancelled bookings are counted only under Outcomes.</p>
    {error && <p className="alert">{error}</p>}
    {!rows && !error && <p className="muted">Loading…</p>}
    {a && !a.total && <p className="empty">No bookings in this period yet. Charts appear as soon as clients book.</p>}
    {a && !!a.total && <>
      <div className="kpis">
        <Kpi value={fmtN(a.live)} label="Appointments" note={`${fmtN(a.upcoming)} upcoming`}/>
        <Kpi value={fmtN(a.clients)} label="Unique clients" note={`${fmtN(a.returning)} came back more than once`}/>
        <Kpi value={`${pct(a.done, a.done + a.noShow)}%`} label="Show-up rate" note={`${fmtN(a.done)} completed · ${fmtN(a.noShow)} no-show`}/>
        <Kpi value={`${pct(a.cancelled, a.total)}%`} label="Cancelled" note={`${fmtN(a.cancelled)} of ${fmtN(a.total)} bookings`}/>
      </div>
      <div className="viz-grid">
        <Card title={a.weekly ? 'Appointments per week' : 'Appointments per day'} wide>
          {tables ? <Table rows={a.buckets.filter(b => b.n).map(b => [a.weekly ? `Week of ${b.label}` : b.label, b.n])} head={['Date', 'Appointments']}/> : <Columns buckets={a.buckets} weekly={a.weekly} tip={tip}/>}
        </Card>
        <Card title="Busiest days and times" wide>
          {tables ? <Table head={['Day', 'Hour', 'Appointments']} rows={[...a.heat.entries()].sort((x, y) => y[1] - x[1]).map(([k, n]) => { const [d, h] = k.split('-').map(Number); return [DAY_SHORT[d], `${h}:00`, n]; })}/> : <Heatmap heat={a.heat} tip={tip}/>}
        </Card>
        <Card title="By service">{tables ? <Table head={['Service', 'Appointments']} rows={a.byService}/> : <Bars data={a.byService} total={a.live} tip={tip}/>}</Card>
        <Card title="Who referred clients">{tables ? <Table head={['Referred by', 'Appointments']} rows={a.byRef}/> : <Bars data={a.byRef.slice(0, 8)} total={a.live} tip={tip} more={a.byRef.length - 8}/>}</Card>
        <Card title="Meeting type">{tables ? <Table head={['Meeting', 'Appointments']} rows={a.byMode}/> : <Bars data={a.byMode} total={a.live} tip={tip}/>}</Card>
        <Card title="Outcomes">{tables ? <Table head={['Status', 'Bookings']} rows={a.byStatus}/> : <Bars data={a.byStatus} total={a.total} tip={tip}/>}</Card>
        <Card title="Top universities and institutions">{a.institutions.length ? (tables ? <Table head={['Institution', 'Appointments']} rows={a.institutions}/> : <Bars data={a.institutions.slice(0, 8)} total={a.live} tip={tip} more={a.institutions.length - 8}/>) : <p className="muted">No institutions entered yet.</p>}</Card>
        <Card title="“Something else” requests">{a.otherTyped.length ? <ul className="typed">{a.otherTyped.slice(0, 10).map(([t, n]) => <li key={t}><span>{t}</span><strong>{n}</strong></li>)}</ul> : <p className="muted">No custom requests in this period.</p>}</Card>
      </div>
    </>}
    {tip.node}
  </section>;
}

function Kpi({ value, label, note }: { value: string; label: string; note: string }) {
  return <div className="kpi"><strong>{value}</strong><span>{label}</span><small>{note}</small></div>;
}
function Card({ title, wide, children }: { title: string; wide?: boolean; children: ReactNode }) {
  return <div className={`viz-card ${wide ? 'wide' : ''}`}><h2>{title}</h2>{children}</div>;
}
function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return <div className="table-wrap flat"><table><thead><tr>{head.map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div>;
}

/** Horizontal bars, one hue; value at the tip, label above. */
function Bars({ data, total, tip, more = 0 }: { data: [string, number][]; total: number; tip: Tip; more?: number }) {
  const max = Math.max(1, ...data.map(d => d[1]));
  return <div className="hbars">
    {data.map(([label, n]) => <div key={label} className="hbar" tabIndex={0}
      onPointerMove={e => tip.show(e, `${fmtN(n)} (${pct(n, total)}%)`, label)} onPointerLeave={tip.hide}
      onFocus={e => tip.show(null, `${fmtN(n)} (${pct(n, total)}%)`, label, e.currentTarget)} onBlur={tip.hide}>
      <span className="hbar-label">{label}</span>
      <span className="hbar-track"><span className="hbar-fill" style={{ width: `${(n / max) * 100}%` }}/><span className="hbar-value">{fmtN(n)}</span></span>
    </div>)}
    {more > 0 && <p className="muted small">+{more} more in table view</p>}
  </div>;
}

/** Column chart over time with clean y ticks and a per-column hover target. */
function Columns({ buckets, weekly, tip }: { buckets: { label: string; n: number }[]; weekly: boolean; tip: Tip }) {
  const W = 760, H = 220, L = 34, B = 26, T = 10;
  const max = Math.max(1, ...buckets.map(b => b.n));
  const step = max <= 5 ? 1 : max <= 10 ? 2 : Math.ceil(max / 5 / 5) * 5;
  const top = Math.ceil(max / step) * step;
  const band = (W - L) / buckets.length, bar = Math.min(24, Math.max(2, band - 2));
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const every = Math.max(1, Math.ceil(buckets.length / 8));
  const fmt = (d: string) => new Date(d + 'T12:00:00+06:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Dhaka' });
  const peak = buckets.reduce((p, b, i) => (b.n > buckets[p].n ? i : p), 0);
  return <svg viewBox={`0 0 ${W} ${H}`} className="cols" role="img" aria-label={`Appointments per ${weekly ? 'week' : 'day'}`}>
    {Array.from({ length: top / step + 1 }, (_, i) => i * step).map(v => <g key={v}>
      <line x1={L} x2={W} y1={y(v)} y2={y(v)} className="grid"/><text x={L - 8} y={y(v) + 4} className="tick" textAnchor="end">{v}</text></g>)}
    {buckets.map((b, i) => { const x = L + i * band + (band - bar) / 2, h = (H - T - B) * (b.n / top);
      return <g key={b.label}>
        {b.n > 0 && <path className="col" d={`M${x},${H - B} V${H - B - h + Math.min(4, h)} q0,-${Math.min(4, h)} ${Math.min(4, bar / 2)},-${Math.min(4, h)} H${x + bar - Math.min(4, bar / 2)} q${Math.min(4, bar / 2)},0 ${Math.min(4, bar / 2)},${Math.min(4, h)} V${H - B} Z`}/>}
        {i === peak && b.n > 0 && <text x={x + bar / 2} y={H - B - h - 6} textAnchor="middle" className="val">{b.n}</text>}
        <rect x={L + i * band} y={T} width={band} height={H - T - B} className="hit" tabIndex={0}
          onPointerMove={e => tip.show(e, `${fmtN(b.n)} appointment${b.n === 1 ? '' : 's'}`, weekly ? `Week of ${fmt(b.label)}` : fmt(b.label))} onPointerLeave={tip.hide}
          onFocus={e => tip.show(null, `${fmtN(b.n)} appointments`, weekly ? `Week of ${fmt(b.label)}` : fmt(b.label), e.currentTarget)} onBlur={tip.hide}/>
        {i % every === 0 && <text x={L + i * band + band / 2} y={H - 8} textAnchor="middle" className="tick">{fmt(b.label)}</text>}
      </g>; })}
    <line x1={L} x2={W} y1={H - B} y2={H - B} className="axis"/>
  </svg>;
}

/** Weekday × hour heatmap, sequential single-hue ramp. */
function Heatmap({ heat, tip }: { heat: Map<string, number>; tip: Tip }) {
  const hours = Array.from({ length: 10 }, (_, i) => 10 + i).filter(h => h < 19);
  const max = Math.max(1, ...heat.values());
  const shade = (n: number) => (n ? RAMP[Math.min(RAMP.length - 1, 1 + Math.floor(((n - 1) / max) * (RAMP.length - 1)))] : RAMP[0]);
  const hl = (h: number) => (h === 12 ? '12 pm' : h > 12 ? `${h - 12} pm` : `${h} am`);
  return <div className="heat">
    <div className="heat-grid" style={{ gridTemplateColumns: `44px repeat(${hours.length}, 1fr)` }}>
      <span/>{hours.map(h => <span key={h} className="tick">{hl(h)}</span>)}
      {DAYS.map(d => <div key={d} className="heat-row" style={{ display: 'contents' }}>
        <span className="tick heat-day">{DAY_SHORT[d]}</span>
        {hours.map(h => { const n = heat.get(`${d}-${h}`) || 0;
          return <span key={h} className={`cell ${d === 5 ? 'closed' : ''}`} style={{ background: shade(n) }} tabIndex={0}
            onPointerMove={e => tip.show(e, `${n} appointment${n === 1 ? '' : 's'}`, `${DAY_SHORT[d]} ${hl(h)}`)} onPointerLeave={tip.hide}
            onFocus={e => tip.show(null, `${n} appointments`, `${DAY_SHORT[d]} ${hl(h)}`, e.currentTarget)} onBlur={tip.hide}/>; })}
      </div>)}
    </div>
    <div className="heat-legend"><span className="tick">Fewer</span>{RAMP.map(c => <i key={c} style={{ background: c }}/>)}<span className="tick">More</span></div>
  </div>;
}
