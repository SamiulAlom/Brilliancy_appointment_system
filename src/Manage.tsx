import { useEffect, useState } from 'react';
import Brand from './Brand';
import { api, type PublicBooking } from './lib/api';

const token = new URLSearchParams(location.search).get('token') || '';
const STATUS: Record<string, string> = { confirmed: 'Confirmed', completed: 'Completed', no_show: 'Missed', cancelled: 'Cancelled' };

export default function Manage() {
  const [booking, setBooking] = useState<PublicBooking | null>(null);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ booking: PublicBooking }>('/api/public/manage?token=' + encodeURIComponent(token)).then(r => setBooking(r.booking)).catch((e: Error) => setError(e.message)); }, []);
  async function cancel() {
    setBusy(true); setError('');
    try { setBooking((await api<{ booking: PublicBooking }>('/api/public/manage/cancel', { method: 'POST', body: JSON.stringify({ token }) })).booking); setConfirming(false); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="done-shell">
    <Brand caption="Appointments"/>
    <div className="ticket">
      {!booking && !error && <p className="muted">Loading your appointment…</p>}
      {error && <p className="alert" role="alert">{error}</p>}
      {booking && <>
        <p className={`pill ${booking.status}`}>{STATUS[booking.status] || booking.status}</p>
        <h1>{booking.service_name}</h1>
        <p className="ticket-when">{booking.when_label}</p>
        <dl>
          <div><dt>Name</dt><dd>{booking.client_name}</dd></div>
          <div><dt>Meeting</dt><dd>{booking.mode === 'office' ? `At our office: ${booking.office_address}` : booking.mode === 'meet'
            ? (booking.meet_link ? <a href={booking.meet_link} target="_blank" rel="noreferrer">{booking.meet_link}</a> : 'Google Meet link is in your calendar invitation') : 'Phone call to your number'}</dd></div>
        </dl>
        {booking.status === 'cancelled' && <p>This appointment is cancelled and the time is free for others. You can book a new time whenever you like.</p>}
        {booking.can_cancel && !confirming && <><p>To change the time, cancel this appointment and book a new one.</p><button className="secondary" onClick={() => setConfirming(true)}>Cancel appointment</button></>}
        {confirming && <div className="confirm-box"><p>Cancel this appointment? This frees the time for other clients.</p>
          <button className="danger" disabled={busy} onClick={cancel}>{busy ? 'Cancelling…' : 'Yes, cancel it'}</button>
          <button className="link" onClick={() => setConfirming(false)}>Keep my appointment</button></div>}
        <a className="link" href="/">Book a new appointment</a>
      </>}
    </div>
  </div>;
}
