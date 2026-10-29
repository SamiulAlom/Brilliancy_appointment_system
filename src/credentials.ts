// Printable / Word "login credentials" document for new or reset team accounts.
// Built in the browser from the server's one-time answer, so passwords are never stored anywhere else.
export type Credential = { full_name: string; email: string; phone?: string | null; password: string };

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const stamp = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date());

export function credentialsHtml(list: Credential[], title = 'Communication team — login credentials') {
  const origin = location.origin;
  const login = `${origin}/team`;
  const logo = `${origin}/brand/email-logo.jpg`;
  const rows = list.map((c, i) => `<tr><td>${i + 1}</td><td><b>${esc(c.full_name)}</b></td><td>${esc(c.email)}</td><td class="pw">${esc(c.password)}</td></tr>`).join('');
  const slips = list.map(c => `
  <div class="slip">
    <div class="slip-head"><img src="${logo}" alt="Brilliancy Research" width="150"><span>Communication team portal</span></div>
    <p class="hi">Hello <b>${esc(c.full_name)}</b>, here is your account for the appointment team portal.</p>
    <table class="kv">
      <tr><th>Sign-in page</th><td><b>${esc(login)}</b></td></tr>
      <tr><th>Email</th><td><b>${esc(c.email)}</b></td></tr>
      <tr><th>Temporary password</th><td class="pw">${esc(c.password)}</td></tr>
    </table>
    <ol>
      <li>Open the sign-in page and choose <b>Communication team</b>.</li>
      <li>Sign in with your email and the temporary password above.</li>
      <li>You will be asked to choose your own password (at least 10 characters).</li>
      <li>Forgot it later? Use <b>Forgot password?</b> on the sign-in page.</li>
    </ol>
    <p class="private">Keep this private. Do not share your password with anyone.</p>
  </div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 16mm; }
  body { font-family: 'Segoe UI', Calibri, Arial, sans-serif; color: #1d1d1f; font-size: 11pt; margin: 0; }
  .cover { border-bottom: 3px solid #c62828; padding-bottom: 10px; margin-bottom: 14px; }
  .cover-top { background: #000; padding: 12px 16px; border-radius: 8px; display: inline-block; }
  h1 { font-family: Georgia, 'Times New Roman', serif; font-size: 20pt; margin: 14px 0 4px; }
  .meta { color: #666; font-size: 10pt; margin: 0; }
  .note { background: #fff4e5; border: 1px solid #ffd8a8; color: #7a4300; border-radius: 6px; padding: 8px 12px; font-size: 10pt; margin: 12px 0; }
  table.list { width: 100%; border-collapse: collapse; margin: 6px 0 18px; }
  table.list th { text-align: left; background: #f3f2f5; font-size: 9.5pt; text-transform: uppercase; letter-spacing: .04em; color: #555; padding: 7px 8px; border-bottom: 2px solid #ddd; }
  table.list td { padding: 7px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  .pw { font-family: Consolas, 'Courier New', monospace; font-size: 12pt; font-weight: 700; letter-spacing: .06em; color: #8e0000; }
  h2 { font-size: 13pt; margin: 18px 0 8px; }
  .slip { border: 1.5px dashed #bbb; border-radius: 10px; padding: 14px 16px; margin: 0 0 14px; page-break-inside: avoid; break-inside: avoid; }
  .slip-head { background: #000; border-radius: 6px; padding: 8px 12px; display: flex; align-items: center; justify-content: space-between; }
  .slip-head span { color: #ddd; font-size: 9pt; letter-spacing: .06em; text-transform: uppercase; }
  .hi { margin: 10px 0 8px; }
  table.kv { border-collapse: collapse; margin: 0 0 8px; }
  table.kv th { text-align: left; font-weight: 600; color: #666; font-size: 10pt; padding: 3px 14px 3px 0; white-space: nowrap; }
  table.kv td { padding: 3px 0; }
  ol { margin: 6px 0 6px 18px; padding: 0; font-size: 10pt; color: #333; }
  .private { margin: 6px 0 0; font-size: 9pt; color: #a00; font-weight: 600; }
  .break { page-break-before: always; break-before: page; }
</style></head><body>
  <div class="cover">
    <div class="cover-top"><img src="${logo}" alt="Brilliancy Research" width="190"></div>
    <h1>${esc(title)}</h1>
    <p class="meta">Generated ${esc(stamp())} (Bangladesh time) · ${list.length} account${list.length === 1 ? '' : 's'} · Sign-in page: ${esc(login)}</p>
  </div>
  <p class="note"><b>Confidential.</b> These are temporary passwords. Each person must choose a new password the first time they sign in. Hand each person only their own slip, then delete or shred this document.</p>
  <table class="list"><thead><tr><th>#</th><th>Name</th><th>Email (username)</th><th>Temporary password</th></tr></thead><tbody>${rows}</tbody></table>
  <h2 class="break">Slips to hand out</h2>
  ${slips}
</body></html>`;
}

export function downloadWord(list: Credential[], name = 'team-login-credentials') {
  const blob = new Blob(['﻿' + credentialsHtml(list)], { type: 'application/msword' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${name}.doc`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
export function printCredentials(list: Credential[]) {
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.open(); w.document.write(credentialsHtml(list)); w.document.close();
  w.onload = () => { w.focus(); w.print(); };
  return true;
}
export function downloadCsv(list: Credential[], name = 'team-login-credentials') {
  const lines = [['Name', 'Email (username)', 'Phone', 'Temporary password', 'Sign-in page'], ...list.map(c => [c.full_name, c.email, c.phone || '', c.password, `${location.origin}/team`])]
    .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + lines], { type: 'text/csv;charset=utf-8' })); a.download = `${name}.csv`; a.click();
}
