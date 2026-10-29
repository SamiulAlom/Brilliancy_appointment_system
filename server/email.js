// Email content: every message is a branded card (HTML) with a plain-text twin.
// Layout uses tables and inline styles only, so it renders in Gmail, Outlook and phone mail apps.
const ZONE = 'Asia/Dhaka';
const MODES = { office: 'In office', meet: 'Google Meet (online)', phone: 'Phone call' };
const RED = '#c62828', RED_DARK = '#8e0000', INK = '#1d1d1f', MUTED = '#6b6b70', LINE = '#ececef', PAGE = '#f4f4f6';
const FONT = "'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (iso, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, ...opts }).format(new Date(iso));
const fmtWhen = (iso) => fmt(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
const fmtDate = (iso) => fmt(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtTime = (iso) => fmt(iso, { hour: 'numeric', minute: '2-digit', hour12: true });

function card({ site, preheader, badge, badgeColor = RED, title, greeting, intro, rows, button, secondary, note, footerAddress }) {
  const logo = `${site}/brand/email-logo.jpg`;
  const rowHtml = rows.filter(r => r && r[1]).map(([label, value, link], i) => `
              <tr>
                <td style="padding:12px 0;${i ? `border-top:1px solid ${LINE};` : ''}width:38%;vertical-align:top;font:600 12px/1.4 ${FONT};color:${MUTED};text-transform:uppercase;letter-spacing:.06em;">${esc(label)}</td>
                <td style="padding:12px 0;${i ? `border-top:1px solid ${LINE};` : ''}vertical-align:top;font:500 15px/1.5 ${FONT};color:${INK};">${link ? `<a href="${esc(link)}" style="color:${RED};text-decoration:none;">${esc(value)}</a>` : esc(value).replace(/\n/g, '<br>')}</td>
              </tr>`).join('');
  const btn = button ? `
          <tr><td style="padding:8px 32px 4px;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
              <td style="border-radius:8px;background:${RED};background-image:linear-gradient(135deg,#e53935,${RED_DARK});">
                <a href="${esc(button.url)}" style="display:inline-block;padding:13px 26px;font:600 15px/1 ${FONT};color:#ffffff;text-decoration:none;border-radius:8px;">${esc(button.label)}</a>
              </td>
              ${secondary ? `<td style="width:12px;"></td><td style="border-radius:8px;border:1px solid #d6d6db;">
                <a href="${esc(secondary.url)}" style="display:inline-block;padding:12px 22px;font:600 15px/1 ${FONT};color:${INK};text-decoration:none;border-radius:8px;">${esc(secondary.label)}</a>
              </td>` : ''}
            </tr></table>
          </td></tr>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${PAGE};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader || intro)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${PAGE};">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid ${LINE};box-shadow:0 6px 24px rgba(20,20,30,.06);">
        <tr><td style="background:#000000;padding:22px 32px;">
          <img src="${esc(logo)}" width="200" height="56" alt="Brilliancy Research" style="display:block;border:0;width:200px;height:auto;max-width:200px;">
        </td></tr>
        <tr><td style="height:4px;line-height:4px;font-size:0;background:${RED};background-image:linear-gradient(90deg,#e53935,${RED_DARK});">&nbsp;</td></tr>
        <tr><td style="padding:30px 32px 6px;">
          ${badge ? `<span style="display:inline-block;padding:5px 11px;border-radius:999px;background:${badgeColor}14;color:${badgeColor};font:700 11px/1 ${FONT};letter-spacing:.08em;text-transform:uppercase;">${esc(badge)}</span>` : ''}
          <h1 style="margin:14px 0 10px;font:700 24px/1.3 Georgia, 'Times New Roman', serif;color:${INK};">${esc(title)}</h1>
          ${greeting ? `<p style="margin:0 0 8px;font:600 15px/1.6 ${FONT};color:${INK};">${esc(greeting)}</p>` : ''}
          <p style="margin:0;font:400 15px/1.6 ${FONT};color:#3a3a3f;">${esc(intro).replace(/\n/g, '<br>')}</p>
        </td></tr>
        <tr><td style="padding:20px 32px 14px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#fafafb;border:1px solid ${LINE};border-radius:10px;">
            <tr><td style="padding:6px 20px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rowHtml}
              </table>
            </td></tr>
          </table>
        </td></tr>${btn}
        ${note ? `<tr><td style="padding:14px 32px 0;font:400 13px/1.6 ${FONT};color:${MUTED};">${esc(note).replace(/\n/g, '<br>')}</td></tr>` : ''}
        <tr><td style="padding:28px 32px 26px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px solid ${LINE};"><tr>
            <td style="padding-top:18px;font:400 12px/1.6 ${FONT};color:${MUTED};">
              <strong style="color:${INK};">Brilliancy Research</strong><br>${esc(footerAddress)}<br>
              <a href="${esc(site)}" style="color:${RED};text-decoration:none;">${esc(site.replace(/^https?:\/\//, ''))}</a>
            </td>
          </tr></table>
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font:400 11px/1.5 ${FONT};color:#9a9aa0;">All times are Bangladesh time (GMT+6).</p>
    </td></tr>
  </table>
</body></html>`;
}

const textOf = ({ greeting, intro, rows, button, secondary, note, footerAddress }) =>
  [greeting, intro, '', ...rows.filter(r => r && r[1]).map(([l, v]) => `${l}: ${v}`), '',
    button ? `${button.label}: ${button.url}` : null, secondary ? `${secondary.label}: ${secondary.url}` : null,
    note ? `\n${note}` : null, '', 'Brilliancy Research', footerAddress].filter(v => v !== null).join('\n');

// kind: confirmation | reminder | cancellation | admin_alert | referrer_alert. forAdmin: the copy goes to the office.
export function emailContent(kind, b, settings, env, forAdmin = false) {
  const site = (env.PUBLIC_SITE_URL || '').replace(/\/$/, '');
  const manageUrl = b._manage ? `${site}/manage?token=${b._manage}` : null;
  const footerAddress = settings.office_address;
  const meeting = b.mode === 'office' ? ['Venue', `Brilliancy Research, ${settings.office_address}`]
    : b.mode === 'meet' ? ['Google Meet', b.meet_link || 'The link is in your Google Calendar invitation.', b.meet_link || null]
    : ['Phone call', `We will call you on ${b.client_phone}`];
  const timeRows = [['Date', fmtDate(b.start_at)], ['Time', `${fmtTime(b.start_at)} – ${fmtTime(b.end_at)} (${b.duration_min} min)`]];
  const base = { site, footerAddress };
  let m;
  if (kind === 'confirmation') m = { subject: `Appointment confirmed: ${fmtWhen(b.start_at)}`, badge: 'Confirmed', badgeColor: '#2e7d32',
    greeting: `Dear ${b.client_name},`, title: 'Your appointment is confirmed',
    intro: 'Thank you for booking with Brilliancy Research. We look forward to meeting you.',
    rows: [['Service', b.service_name], ...timeRows, meeting, ['Booking ref', b.id.slice(0, 8).toUpperCase()]],
    button: manageUrl && { label: 'View or cancel booking', url: manageUrl },
    secondary: b.mode === 'meet' && b.meet_link ? { label: 'Join Google Meet', url: b.meet_link } : null,
    note: 'Need a different time? Cancel with the button above and book a new slot. You can reply to this email with any questions.' };
  else if (kind === 'reminder') m = { subject: `Reminder: your appointment on ${fmtWhen(b.start_at)}`, badge: 'Reminder', badgeColor: '#ef6c00',
    greeting: `Dear ${b.client_name},`, title: 'See you soon',
    intro: 'This is a friendly reminder of your upcoming appointment with Brilliancy Research.',
    rows: [['Service', b.service_name], ...timeRows, meeting],
    button: b.mode === 'meet' && b.meet_link ? { label: 'Join Google Meet', url: b.meet_link } : manageUrl && { label: 'View booking', url: manageUrl },
    secondary: b.mode === 'meet' && b.meet_link && manageUrl ? { label: 'View booking', url: manageUrl } : null };
  else if (kind === 'cancellation' && forAdmin) m = { subject: `Cancelled by client: ${b.client_name} — ${fmtWhen(b.start_at)}`, badge: 'Cancelled', badgeColor: RED,
    greeting: 'Hello,', title: 'A client cancelled', intro: 'The client cancelled this appointment. The time slot is free again.',
    rows: [['Client', b.client_name], ['Phone', b.client_phone, `tel:${b.client_phone}`], ['Email', b.client_email, `mailto:${b.client_email}`], ['Service', b.service_name], ...timeRows],
    button: { label: 'Open admin', url: `${site}/admin` } };
  else if (kind === 'cancellation') m = { subject: `Appointment cancelled: ${fmtWhen(b.start_at)}`, badge: 'Cancelled', badgeColor: RED,
    greeting: `Dear ${b.client_name},`, title: 'Your appointment has been cancelled',
    intro: b.cancelled_by === 'client' ? 'As requested, your appointment has been cancelled.' : 'Your appointment with Brilliancy Research has been cancelled. We are sorry for any inconvenience.',
    rows: [['Service', b.service_name], ...timeRows],
    button: { label: 'Book a new time', url: `${site}/` }, note: 'If you have any questions, simply reply to this email.' };
  else if (kind === 'referrer_alert') m = { subject: `Your referral booked: ${b.client_name} — ${fmtWhen(b.start_at)}`, badge: 'New referral', badgeColor: '#6a1b9a',
    greeting: 'Hello,', title: 'Your referral booked an appointment',
    intro: 'A client you referred has booked an appointment with Brilliancy Research. Thank you for the referral.',
    rows: [['Client', b.client_name], ['Service', b.service_name], ...timeRows, ['Meeting', MODES[b.mode]]] };
  else m = { subject: `New appointment: ${b.client_name} — ${fmtWhen(b.start_at)}`, badge: 'New booking', badgeColor: '#1565c0',
    greeting: 'Hello,', title: `New appointment with ${b.client_name}`,
    intro: b.status === 'confirmed' ? 'A new appointment has been booked and added to the office Google Calendar.' : 'A new appointment has been booked. The calendar entry is pending and will be retried automatically.',
    rows: [['Client', b.client_name], ['Phone', b.client_phone, `tel:${b.client_phone}`], ['Email', b.client_email, `mailto:${b.client_email}`],
      ['Institution', b.client_institution], ['Service', b.service_name], ...timeRows, ['Meeting', MODES[b.mode]], ['Referred by', b._referrer], ['Client note', b.client_note]],
    button: { label: 'Open admin', url: `${site}/admin` } };
  const parts = { ...base, ...m, preheader: `${m.title} — ${fmtWhen(b.start_at)}` };
  return { subject: m.subject, text: textOf(parts), html: card(parts) };
}

// Password reset link for a team member or administrator.
export function resetEmail({ name, email, url, role, minutes }, settings, env) {
  const site = (env.PUBLIC_SITE_URL || '').replace(/\/$/, '');
  const parts = { site, footerAddress: settings.office_address, badge: 'Password reset', badgeColor: '#1565c0',
    greeting: `Hello ${name},`, title: 'Reset your password',
    intro: `We received a request to reset the password for your Brilliancy Research ${role === 'team' ? 'communication team' : 'administrator'} account. Use the button below to choose a new password.`,
    rows: [['Account', email], ['Link valid for', `${minutes} minutes, one use only`]],
    button: { label: 'Choose a new password', url },
    note: 'If you did not ask for this, you can ignore this email — your password will not change.' };
  return { subject: 'Reset your Brilliancy Research password', text: textOf(parts), html: card({ ...parts, preheader: 'Reset your password' }) };
}
