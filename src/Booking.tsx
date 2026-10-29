import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Building2, CalendarCheck, Check, Clock3, PenLine, Phone, Video } from 'lucide-react';
import Brand from './Brand';
import RefPicker from './RefPicker';
import { api, ApiError, type Mode, type PublicBooking, type PublicConfig } from './lib/api';
import { addDays, at, fmtDay, fmtTime, weekday } from './lib/time';

const MODE_INFO: Record<Mode, { label: string; hint: string; Icon: typeof Video }> = {
  office: { label: 'At our office', hint: 'Fareast Tower, Topkhana Road', Icon: Building2 },
  meet: { label: 'Google Meet', hint: 'Video call link by email', Icon: Video },
  phone: { label: 'Phone call', hint: 'We call your number', Icon: Phone },
};
type Slot = { start: string; label: string };
const params = new URLSearchParams(location.search);
const REF_FROM_LINK = (params.get('ref') || '').trim();
const OTHER = 'other';

export default function Booking() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [loadError, setLoadError] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [mode, setMode] = useState<Mode | ''>('');
  const [date, setDate] = useState('');
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slotError, setSlotError] = useState('');
  const [start, setStart] = useState('');
  const [form, setForm] = useState({ name: '', phone: '', email: '', institution: '', note: '' });
  const [serviceOther, setServiceOther] = useState('');
  const [refChoice, setRefChoice] = useState('');      // employee code, '__none' or '__other'
  const [refOther, setRefOther] = useState('');
  const [refLocked, setRefLocked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ booking: PublicBooking; manage_token: string } | null>(null);
  const idem = useRef(crypto.randomUUID());
  const turnstileBox = useRef<HTMLDivElement>(null);
  const [turnstileToken, setTurnstileToken] = useState('');
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;

  useEffect(() => {
    api<PublicConfig>('/api/public/config').then(c => {
      setConfig(c);
      if (c.services.length === 1) setServiceId(c.services[0].id);
      if (c.settings.modes.length === 1) setMode(c.settings.modes[0]);
      const ref = c.referrers.find(r => r.code.toLowerCase() === REF_FROM_LINK.toLowerCase());
      if (ref) { setRefChoice(ref.code); setRefLocked(true); }
    }).catch((e: Error) => setLoadError(e.message));
  }, []);

  useEffect(() => {
    if (!siteKey || !turnstileBox.current || turnstileBox.current.dataset.ready) return;
    turnstileBox.current.dataset.ready = '1';
    const render = () => window.turnstile?.render(turnstileBox.current!, { sitekey: siteKey, callback: (t: string) => setTurnstileToken(t), 'expired-callback': () => setTurnstileToken('') });
    if (window.turnstile) render();
    else { const s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'; s.async = true; s.onload = render; document.head.appendChild(s); }
  });

  const service = serviceId === OTHER && config
    ? { id: OTHER, name: serviceOther.trim() ? `Other: ${serviceOther.trim()}` : 'Other service', description: '', duration_min: config.other_duration_min || 30 }
    : config?.services.find(s => s.id === serviceId);
  const days = useMemo(() => {
    if (!config) return [];
    const { settings, today, off_days } = config;
    return Array.from({ length: settings.max_days_ahead + 1 }, (_, i) => {
      const d = addDays(today, i);
      const off = off_days.find(o => o.from_date <= d && d <= o.to_date);
      const closed = !settings.working_days.includes(weekday(d)) || !!off;
      return { date: d, closed, reason: off?.reason || (closed ? 'Closed' : '') };
    });
  }, [config]);

  const loadSlots = (d: string, sid: string) => {
    setSlots(null); setSlotError(''); setStart('');
    api<{ slots: Slot[] }>(`/api/public/slots?date=${d}&service=${sid}`).then(r => setSlots(r.slots)).catch((e: Error) => setSlotError(e.message));
  };
  useEffect(() => { if (date && serviceId) loadSlots(date, serviceId); }, [date, serviceId]);

  // Every time the office could start this service that day; ones not returned by the server are taken or too soon.
  const daybook = useMemo(() => {
    if (!config || !service || !date) return [];
    const { open_time, close_time, slot_step_min } = config.settings;
    const out: { ms: number; free: Slot | undefined }[] = [];
    const freeByMs = new Map((slots || []).map(s => [Date.parse(s.start), s]));
    for (let t = at(date, open_time); t + service.duration_min * 60e3 <= at(date, close_time); t += slot_step_min * 60e3) out.push({ ms: t, free: freeByMs.get(t) });
    return out;
  }, [config, service, date, slots]);

  const refName = config?.referrers.find(r => r.code === refChoice)?.name;
  const ready = !!(service && (serviceId !== OTHER || serviceOther.trim().length >= 3) && mode && start && form.name.trim().length >= 2 && form.phone && form.email && refChoice && (refChoice !== '__other' || refOther.trim().length >= 2) && (!siteKey || turnstileToken));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || submitting) return;
    setSubmitting(true); setError('');
    try {
      const res = await api<{ booking: PublicBooking; manage_token: string }>('/api/public/bookings', { method: 'POST', body: JSON.stringify({
        idempotency_key: idem.current, service_id: serviceId, service_other: serviceId === OTHER ? serviceOther : undefined, mode, start, ...form,
        referrer_source: refChoice === '__other' ? 'other' : refChoice === '__none' ? 'none' : refLocked ? 'link' : 'dropdown',
        referrer_code: refChoice.startsWith('__') ? null : refChoice, referrer_other: refChoice === '__other' ? refOther : '',
        turnstile_token: turnstileToken || undefined,
      }) });
      setDone(res); window.scrollTo({ top: 0 });
    } catch (err) {
      const ex = err as ApiError;
      setError(ex.message);
      if (ex.code === 'SLOT_TAKEN') { idem.current = crypto.randomUUID(); loadSlots(date, serviceId); }
      if (ex.code?.startsWith('CAPTCHA')) { window.turnstile?.reset(); setTurnstileToken(''); }
    } finally { setSubmitting(false); }
  }

  if (done) return <Confirmation {...done}/>;

  return <div className="book-shell">
    <aside className="book-aside">
      <Brand caption="Appointments"/>
      <h1>Book a consultation</h1>
      <p className="lede">Meet our team about your manuscript, proposal, thesis formatting, CV, scholarship application or GIS project. All times are Bangladesh time.</p>
      <dl className="summary" aria-live="polite">
        <div><dt>Service</dt><dd>{service ? <>{service.name}<small>{service.duration_min} minutes</small></> : <em>Not chosen</em>}</dd></div>
        <div><dt>Meeting</dt><dd>{mode ? MODE_INFO[mode].label : <em>Not chosen</em>}</dd></div>
        <div><dt>Date & time</dt><dd>{start ? <>{fmtDay(date)}<small>{fmtTime(start)} – {fmtTime(Date.parse(start) + (service?.duration_min || 0) * 60e3)}</small></> : <em>Not chosen</em>}</dd></div>
        {refChoice && <div><dt>Referred by</dt><dd>{refChoice === '__none' ? 'No one' : refChoice === '__other' ? (refOther || 'Someone else') : refName}</dd></div>}
      </dl>
      {config && <p className="hours"><Clock3 size={15}/> Open {fmtTime(at(config.today, config.settings.open_time))} – {fmtTime(at(config.today, config.settings.close_time))}, Saturday to Thursday. {config.settings.office_address}.</p>}
    </aside>

    <main className="book-main">
      {loadError && <p className="alert">{loadError}</p>}
      {!config && !loadError && <p className="muted">Loading available services…</p>}
      {config && <form onSubmit={submit} noValidate>
        <section className="step" aria-labelledby="s1">
          <h2 id="s1"><span className="num">1</span>What do you need help with?</h2>
          <div className="service-list" role="radiogroup" aria-labelledby="s1">
            {config.services.map(s => <label key={s.id} className={`service ${s.id === serviceId ? 'on' : ''}`}>
              <input type="radio" name="service" value={s.id} checked={s.id === serviceId} onChange={() => setServiceId(s.id)}/>
              <span className="service-name">{s.name}</span>
              <span className="service-desc">{s.description}</span>
              <span className="service-len">{s.duration_min} min</span>
            </label>)}
            <label className={`service other ${serviceId === OTHER ? 'on' : ''}`}>
              <input type="radio" name="service" value={OTHER} checked={serviceId === OTHER} onChange={() => setServiceId(OTHER)}/>
              <span className="service-name"><PenLine size={15} aria-hidden/> Something else</span>
              <span className="service-desc">Not listed? Tell us what you need.</span>
              <span className="service-len">{config.other_duration_min || 30} min</span>
            </label>
          </div>
          {serviceId === OTHER && <label className="other-input">What do you need help with?
            <input autoFocus maxLength={120} value={serviceOther} onChange={e => setServiceOther(e.target.value)} placeholder="E.g. plagiarism check, data analysis in SPSS, conference poster"/>
            <small>{serviceOther.trim().length < 3 ? 'Type at least a few words so the right consultant can prepare.' : 'Thanks — we will match you with the right consultant.'}</small>
          </label>}
        </section>

        <section className="step" aria-labelledby="s2">
          <h2 id="s2"><span className="num">2</span>How would you like to meet?</h2>
          <div className="modes" role="radiogroup" aria-labelledby="s2">
            {config.settings.modes.map(m => { const { label, hint, Icon } = MODE_INFO[m]; return <label key={m} className={`mode ${mode === m ? 'on' : ''}`}>
              <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)}/>
              <Icon size={20} aria-hidden/><span>{label}</span><small>{hint}</small>
            </label>; })}
          </div>
        </section>

        <section className="step" aria-labelledby="s3">
          <h2 id="s3"><span className="num">3</span>Pick a day and time</h2>
          {!service && <p className="muted">Choose a service first, so we can show times that fit its length.</p>}
          {service && <>
            <div className="days" role="radiogroup" aria-label="Day">
              {days.map(d => <button type="button" key={d.date} className={`day ${d.date === date ? 'on' : ''}`} disabled={d.closed} aria-pressed={d.date === date}
                title={d.closed ? d.reason : undefined} onClick={() => setDate(d.date)}>
                <span>{fmtDay(d.date, { weekday: 'short' })}</span><strong>{fmtDay(d.date, { day: 'numeric' })}</strong><span>{fmtDay(d.date, { month: 'short' })}</span>
              </button>)}
            </div>
            {!date && <p className="muted">Choose a day to see open times. Fridays and office holidays are closed.</p>}
            {date && <div className="daybook" aria-label={`Times on ${fmtDay(date)}`}>
              <div className="daybook-head"><strong>{fmtDay(date)}</strong>{slots && <span>{slots.length ? `${slots.length} open ${slots.length === 1 ? 'time' : 'times'}` : 'Fully booked'}</span>}</div>
              {slotError && <p className="alert">{slotError} <button type="button" className="link" onClick={() => loadSlots(date, serviceId)}>Try again</button></p>}
              {!slots && !slotError && <p className="muted pad">Checking the office calendar…</p>}
              {slots && daybook.map(row => row.free
                ? <button type="button" key={row.ms} className={`row free ${start === row.free.start ? 'on' : ''}`} aria-pressed={start === row.free.start} onClick={() => setStart(row.free!.start)}>
                    <time>{fmtTime(row.ms)}</time><span>{start === row.free.start ? <><Check size={15}/> Selected</> : 'Open'}</span></button>
                : <div key={row.ms} className="row taken"><time>{fmtTime(row.ms)}</time><span>Not available</span></div>)}
              {slots && !slots.length && <p className="muted pad">No open times this day. Try another day.</p>}
            </div>}
          </>}
        </section>

        <section className="step" aria-labelledby="s4">
          <h2 id="s4"><span className="num">4</span>Your details</h2>
          <div className="fields">
            <label>Full name<input required autoComplete="name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}/></label>
            <label>Phone / WhatsApp<input required type="tel" autoComplete="tel" placeholder="01XXX-XXXXXX" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })}/></label>
            <label>Email<input required type="email" autoComplete="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })}/><small>Your confirmation and calendar invitation go here.</small></label>
            <label>University or institution<input autoComplete="organization" value={form.institution} onChange={e => setForm({ ...form, institution: e.target.value })}/></label>
            <label className="wide">What would you like to discuss?<textarea rows={3} maxLength={1500} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="E.g. journal manuscript in civil engineering, deadline in December"/></label>
            <div className="wide referrer">
              {refLocked && refName
                ? <p className="ref-locked">Referred by <strong>{refName}</strong> <button type="button" className="link" onClick={() => setRefLocked(false)}>Change</button></p>
                : <RefPicker referrers={config.referrers} choice={refChoice} other={refOther} onChange={(c, o) => { setRefChoice(c); setRefOther(o); }}/>}
            </div>
          </div>
          {siteKey && <div ref={turnstileBox} className="turnstile"/>}
          {error && <p className="alert" role="alert">{error}</p>}
          <button className="primary" disabled={!ready || submitting}>{submitting ? 'Booking…' : 'Confirm booking'}</button>
          {!ready && <p className="muted small">Choose a service (or describe it), meeting type and time, then fill in your name, phone, email and who referred you.</p>}
        </section>
      </form>}
    </main>
  </div>;
}

function Confirmation({ booking, manage_token }: { booking: PublicBooking; manage_token: string }) {
  const manage = `/manage?token=${encodeURIComponent(manage_token)}`;
  return <div className="done-shell">
    <Brand caption="Appointments"/>
    <div className="ticket">
      <CalendarCheck size={34} className="ticket-icon" aria-hidden/>
      <h1>You're booked, {booking.client_name.split(' ')[0]}</h1>
      <p className="ticket-when">{booking.when_label}</p>
      <dl>
        <div><dt>Service</dt><dd>{booking.service_name} ({booking.duration_min} minutes)</dd></div>
        <div><dt>Meeting</dt><dd>{booking.mode === 'office' ? `At our office: ${booking.office_address}` : booking.mode === 'meet'
          ? (booking.meet_link ? <a href={booking.meet_link} target="_blank" rel="noreferrer">{booking.meet_link}</a> : 'Google Meet link will be in your calendar invitation')
          : 'We will call the phone number you gave'}</dd></div>
      </dl>
      <p>We've emailed your confirmation, and a Google Calendar invitation is on its way. Keep the link below to view or cancel this appointment.</p>
      <a className="primary" href={manage}>View or cancel this appointment</a>
      <a className="link" href="/">Book another appointment</a>
    </div>
  </div>;
}
