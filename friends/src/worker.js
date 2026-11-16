// Numora (เวอร์ชันสำหรับเพื่อน) — Cloudflare Worker
// • เปิดแอปได้เฉพาะเครื่องที่ใส่ "รหัสเชิญ" แล้ว (รหัสหนึ่งใช้ได้ไม่เกิน max เครื่อง, ค่าเริ่มต้น 2 = เบราว์เซอร์ + แอปบนหน้าจอโฮม)
// • ข้อมูลผลรางวัล (/data/*) ดึงต่อจากเว็บเดิม (GitHub Pages) จึงอัปเดตพร้อมกันโดยไม่ต้องตั้งระบบดึงผลใหม่
// • /admin = หน้าจัดการรหัส (ใช้รหัสผู้ดูแลที่ตั้งเป็น secret ADMIN_PASSWORD)
// ต้องมี: KV binding "CODES", assets binding "ASSETS", secrets ADMIN_PASSWORD + SESSION_SECRET

const DATA_ORIGIN = 'https://thapthimchuea.github.io/numora';
const SESSION_COOKIE = 'nm_s', ADMIN_COOKIE = 'nm_a';
const SESSION_DAYS = 400, ADMIN_HOURS = 12, DEFAULT_MAX = 2;
const PUBLIC_PATHS = new Set(['/manifest.json', '/sw.js', '/robots.txt', '/favicon.ico']); // เบราว์เซอร์โหลดไฟล์พวกนี้โดยไม่ส่งคุกกี้
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* ---------- utils ---------- */
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uStr = s => b64u(enc.encode(s));
const unb64u = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
function safeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function sign(env, obj) { const p = b64uStr(JSON.stringify(obj)); return `${p}.${await hmac(env.SESSION_SECRET, p)}`; }
async function verify(env, tok) {
  if (!tok || !tok.includes('.')) return null;
  const [p, s] = tok.split('.');
  if (!safeEq(s, await hmac(env.SESSION_SECRET, p))) return null;
  try { return JSON.parse(unb64u(p)); } catch { return null; }
}
const cookies = req => Object.fromEntries((req.headers.get('cookie') || '').split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
const setCookie = (name, val, maxAge, path = '/') => `${name}=${encodeURIComponent(val)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^NUM/, '');
const fmtCode = raw => `NUM-${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
function newCode() { const a = crypto.getRandomValues(new Uint8Array(8)); return [...a].map(x => ALPHA[x % ALPHA.length]).join(''); }
const html = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'same-origin', ...headers } });
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

/* ---------- code store (KV) ---------- */
const getCode = async (env, raw) => { const v = await env.CODES.get('code:' + raw); return v ? JSON.parse(v) : null; };
const putCode = (env, raw, rec) => env.CODES.put('code:' + raw, JSON.stringify(rec));
const activeCache = new Map(); // ลดการอ่าน KV: จำผลตรวจไว้ 60 วินาทีต่อเครื่องเซิร์ฟเวอร์
async function codeActive(env, raw, device) {
  const k = raw + '|' + device, hit = activeCache.get(k);
  if (hit && hit.t > Date.now() - 60000) return hit.ok;
  const rec = await getCode(env, raw);
  const ok = !!rec && !rec.revoked && (rec.uses || []).some(u => u.d === device);
  activeCache.set(k, { ok, t: Date.now() });
  return ok;
}

/* ---------- pages ---------- */
const SHELL = (title, inner) => `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#09090b"><title>${title}</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#09090b;color:#e4e4e7;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Thai",sans-serif;display:flex;align-items:center;justify-content:center;padding:20px;
background-image:radial-gradient(circle at 20% 10%,rgba(255,0,200,.12),transparent 40%),radial-gradient(circle at 80% 90%,rgba(0,229,255,.12),transparent 40%)}
.card{width:100%;max-width:420px;border-radius:22px;padding:2px;background:linear-gradient(135deg,#ff1744,#ff00c8,#aa00ff,#00e5ff,#00ff88)}
.in{border-radius:20px;background:#0c0c10;padding:26px 22px}
h1{margin:0 0 4px;font-size:26px;background:linear-gradient(90deg,#ff00c8,#00e5ff);-webkit-background-clip:text;background-clip:text;color:transparent;letter-spacing:.5px}
p{color:#a1a1aa;font-size:14px;line-height:1.6;margin:6px 0}
input,select{width:100%;padding:14px;border-radius:14px;border:1px solid #3f3f46;background:#050507;color:#fff;font-size:18px;letter-spacing:2px;text-align:center;font-family:ui-monospace,monospace;outline:none}
select{font-family:inherit;font-size:15px;letter-spacing:0;text-align:left}input[name=name]{font-family:inherit}
input:focus{border-color:#ff00c8;box-shadow:0 0 0 3px rgba(255,0,200,.25)}
button{width:100%;margin-top:12px;padding:14px;border:0;border-radius:14px;font-size:16px;font-weight:700;color:#fff;background:linear-gradient(90deg,#d500f9,#2979ff);cursor:pointer}
button:disabled{opacity:.5}.err{color:#fda4af;min-height:20px;font-size:13.5px;margin-top:10px}.small{font-size:12px;color:#71717a}
</style></head><body>${inner}</body></html>`;

function invitePage(prefill = '') {
  return html(SHELL('Numora — ใส่รหัสเชิญ', `<div class="card"><div class="in">
<h1>Numora</h1><p>แอปนี้เปิดให้เฉพาะคนที่ได้รับเชิญ กรุณาใส่รหัสเชิญที่ได้รับ</p>
<form id="f" style="margin-top:16px"><input id="c" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="NUM-XXXX-XXXX" value="${esc(prefill)}" maxlength="16"><button id="b">เข้าใช้งาน</button><div class="err" id="e"></div></form>
<p class="small">รหัสหนึ่งใช้ได้ไม่เกิน 2 เครื่อง/เบราว์เซอร์ (เช่น เบราว์เซอร์ + แอปบนหน้าจอโฮม) · ถ้าติดตั้งลงหน้าจอโฮมแล้วถูกถามรหัสอีก ให้ใส่รหัสเดิม</p>
<p class="small">ข้อมูลทั้งหมดเป็นการคำนวณทางสถิติเพื่อความบันเทิงและการศึกษาความน่าจะเป็นเท่านั้น</p>
</div></div>
<script>
let d=localStorage.getItem('nm_dev');if(!d){d=Array.from(crypto.getRandomValues(new Uint8Array(12)),x=>x.toString(16).padStart(2,'0')).join('');localStorage.setItem('nm_dev',d);}
const f=document.getElementById('f'),c=document.getElementById('c'),b=document.getElementById('b'),e=document.getElementById('e');
f.onsubmit=async ev=>{ev.preventDefault();e.textContent='';b.disabled=true;b.textContent='กำลังตรวจ...';
 try{const r=await fetch('/api/redeem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:c.value,device:d})});const j=await r.json();
  if(j.ok){b.textContent='สำเร็จ กำลังเปิดแอป...';location.replace('/');return;} e.textContent=j.error||'ใช้รหัสนี้ไม่ได้';}
 catch(x){e.textContent='เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง';}
 b.disabled=false;b.textContent='เข้าใช้งาน';};
if(c.value)setTimeout(()=>c.focus(),50);
</script>`));
}

/* ---------- redeem ---------- */
async function redeem(req, env) {
  let body = {}; try { body = await req.json(); } catch {}
  const raw = normCode(body.code), device = String(body.device || '').slice(0, 64);
  if (raw.length !== 8 || !/^[0-9a-f]{8,64}$/.test(device)) return json({ ok: false, error: 'รูปแบบรหัสไม่ถูกต้อง (NUM-XXXX-XXXX)' }, 400);
  const rec = await getCode(env, raw);
  if (!rec) return json({ ok: false, error: 'ไม่พบรหัสนี้' }, 404);
  if (rec.revoked) return json({ ok: false, error: 'รหัสนี้ถูกยกเลิกแล้ว' }, 403);
  rec.uses = rec.uses || [];
  if (!rec.uses.some(u => u.d === device)) {
    if (rec.uses.length >= (rec.max || DEFAULT_MAX)) return json({ ok: false, error: 'รหัสนี้ถูกใช้ครบจำนวนเครื่องแล้ว กรุณาขอรหัสใหม่จากผู้ส่ง' }, 403);
    rec.uses.push({ d: device, at: Date.now(), ua: (req.headers.get('user-agent') || '').slice(0, 120) });
    await putCode(env, raw, rec);
  }
  activeCache.delete(raw + '|' + device);
  const tok = await sign(env, { c: raw, d: device, t: Date.now() });
  return json({ ok: true }, 200, { 'set-cookie': setCookie(SESSION_COOKIE, tok, SESSION_DAYS * 86400) });
}

/* ---------- admin ---------- */
const deviceLabel = ua => /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'อื่นๆ';
const thTime = ms => new Date(ms).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });

async function adminPage(env, url, msg = '') {
  const list = []; let cursor;
  do { const r = await env.CODES.list({ prefix: 'code:', cursor }); list.push(...r.keys); cursor = r.list_complete ? null : r.cursor; } while (cursor);
  const recs = (await Promise.all(list.map(async k => [k.name.slice(5), JSON.parse(await env.CODES.get(k.name) || '{}')]))).sort((a, b) => (b[1].created || 0) - (a[1].created || 0));
  const origin = url.origin;
  const rows = recs.map(([raw, r]) => {
    const code = fmtCode(raw), link = `${origin}/?code=${code}`, uses = r.uses || [];
    const st = r.revoked ? '<span style="color:#fda4af">ยกเลิกแล้ว</span>' : uses.length ? `<span style="color:#86efac">ใช้แล้ว ${uses.length}/${r.max || DEFAULT_MAX}</span>` : '<span style="color:#67e8f9">ยังไม่ใช้</span>';
    const act = (a, label, color = '#a1a1aa') => `<form method="post" action="/admin/action" style="display:inline"><input type="hidden" name="a" value="${a}"><input type="hidden" name="code" value="${raw}"><button style="width:auto;margin:4px 4px 0 0;padding:6px 10px;font-size:12px;font-weight:500;background:#18181b;border:1px solid #3f3f46;color:${color}">${label}</button></form>`;
    return `<div style="border:1px solid #27272a;border-radius:14px;padding:12px;margin-top:10px;background:#111114">
<div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><b style="font-family:ui-monospace,monospace;letter-spacing:1px;color:#fff">${code}</b>${st}</div>
<div class="small" style="margin-top:2px">${esc(r.name || '-')} · สร้าง ${r.created ? thTime(r.created) : '-'}</div>
${uses.map(u => `<div class="small">• ${deviceLabel(u.ua || '')} · ${thTime(u.at)}</div>`).join('')}
<input readonly value="${link}" onclick="this.select()" style="margin-top:8px;font-size:12.5px;letter-spacing:0;text-align:left;padding:9px 10px;font-family:ui-monospace,monospace;color:#a5f3fc">
<div style="margin-top:6px"><button type="button" onclick="copyLink(this,'${link}')" style="width:auto;margin:4px 4px 0 0;padding:6px 10px;font-size:12px;font-weight:600">คัดลอกลิงก์เชิญ</button><button type="button" class="sharebtn" onclick="shareLink('${link}')" style="display:none;width:auto;margin:4px 4px 0 0;padding:6px 10px;font-size:12px;font-weight:600;background:linear-gradient(90deg,#00c853,#00b8d4)">แชร์…</button>${r.revoked ? act('restore', 'เปิดใช้อีกครั้ง', '#86efac') : act('revoke', 'ยกเลิกรหัส', '#fda4af')}${uses.length ? act('reset', 'ล้างเครื่องที่ใช้') : ''}${act('delete', 'ลบ', '#71717a')}</div></div>`;
  }).join('');
  const used = recs.filter(([, r]) => (r.uses || []).length && !r.revoked).length;
  return html(SHELL('Numora — จัดการรหัสเชิญ', `<div class="card" style="max-width:560px"><div class="in">
<div style="display:flex;justify-content:space-between;align-items:center"><h1>รหัสเชิญ</h1><a href="/admin/logout" class="small" style="color:#a1a1aa">ออกจากระบบ</a></div>
<p>ทั้งหมด ${recs.length} รหัส · มีคนใช้งานอยู่ ${used} รหัส</p>
${msg ? `<p style="color:#86efac">${esc(msg)}</p>` : ''}
<form method="post" action="/admin/action" style="margin-top:12px;border:1px solid #27272a;border-radius:14px;padding:12px">
<input type="hidden" name="a" value="create"><p style="margin:0 0 8px;color:#e4e4e7">สร้างรหัสใหม่</p>
<input name="name" placeholder="ชื่อเพื่อน (ไม่บังคับ)" style="font-size:15px;letter-spacing:0;text-align:left">
<div style="display:flex;gap:8px;margin-top:8px"><select name="n" style="font-size:15px;letter-spacing:0"><option value="1">1 รหัส</option><option value="3">3 รหัส</option><option value="5">5 รหัส</option><option value="10">10 รหัส</option></select>
<select name="max" style="font-size:15px;letter-spacing:0"><option value="2">ใช้ได้ 2 เครื่อง</option><option value="1">1 เครื่อง</option><option value="3">3 เครื่อง</option></select></div>
<button>สร้างรหัส</button></form>
${rows || '<p class="small" style="margin-top:14px">ยังไม่มีรหัส</p>'}
<script>
async function copyLink(btn, t) {
  let ok = false;
  try { await navigator.clipboard.writeText(t); ok = true; } catch (e) {}
  if (!ok) { const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.focus(); ta.select(); try { ok = document.execCommand('copy'); } catch (e) {} ta.remove(); }
  btn.textContent = ok ? 'คัดลอกแล้ว ✓' : 'คัดลอกไม่ได้ — กดค้างที่ลิงก์ด้านบนเพื่อคัดลอก';
  if (!ok) { const inp = btn.parentElement.previousElementSibling; if (inp) { inp.focus(); inp.select(); } }
  setTimeout(() => (btn.textContent = 'คัดลอกลิงก์เชิญ'), 4000);
}
function shareLink(t) { navigator.share({ title: 'Numora', text: 'ลิงก์เชิญเข้าใช้แอป Numora (ใช้ได้เฉพาะคุณ)', url: t }).catch(() => {}); }
if (navigator.share) document.querySelectorAll('.sharebtn').forEach(b => (b.style.display = 'inline-block'));
</script>
<p class="small" style="margin-top:14px">ส่ง "ลิงก์เชิญ" ให้เพื่อนทีละคน (มีรหัสอยู่ในลิงก์แล้ว) · ถ้าเพื่อนส่งต่อหลังใช้ครบจำนวนเครื่อง คนอื่นจะเปิดไม่ได้</p>
</div></div>`));
}
const adminLogin = (err = '') => html(SHELL('Numora — ผู้ดูแล', `<div class="card"><div class="in"><h1>ผู้ดูแล</h1><p>ใส่รหัสผู้ดูแลเพื่อจัดการรหัสเชิญ</p>
<form method="post" action="/admin/login" style="margin-top:14px"><input type="password" name="p" autocomplete="current-password" placeholder="รหัสผู้ดูแล" style="letter-spacing:0"><button>เข้าสู่ระบบ</button><div class="err">${esc(err)}</div></form></div></div>`), err ? 401 : 200);

const loginFails = new Map();
async function admin(req, env, url) {
  const p = url.pathname;
  if (req.method === 'POST') { // กันการส่งฟอร์มข้ามเว็บ
    const o = req.headers.get('origin'); // บางเบราว์เซอร์ส่ง "null" มา — ยอมรับได้ เพราะคุกกี้เป็น SameSite=Lax อยู่แล้ว
    if (o && o !== 'null' && o !== url.origin) return html('forbidden', 403);
  }
  if (p === '/admin/login' && req.method === 'POST') {
    const ip = req.headers.get('cf-connecting-ip') || 'x', f = loginFails.get(ip) || { n: 0, t: 0 };
    if (f.n >= 5 && Date.now() - f.t < 15 * 60000) return adminLogin('ใส่ผิดหลายครั้ง รอ 15 นาที');
    const form = await req.formData();
    if (!env.ADMIN_PASSWORD || !safeEq(String(form.get('p') || ''), env.ADMIN_PASSWORD)) { loginFails.set(ip, { n: f.n + 1, t: Date.now() }); return adminLogin('รหัสไม่ถูกต้อง'); }
    loginFails.delete(ip);
    const tok = await sign(env, { admin: 1, exp: Date.now() + ADMIN_HOURS * 3600000 });
    return new Response(null, { status: 303, headers: { location: '/admin', 'set-cookie': setCookie(ADMIN_COOKIE, tok, ADMIN_HOURS * 3600, '/admin') } });
  }
  if (p === '/admin/logout') return new Response(null, { status: 303, headers: { location: '/admin', 'set-cookie': setCookie(ADMIN_COOKIE, '', 0, '/admin') } });
  const a = await verify(env, cookies(req)[ADMIN_COOKIE]);
  if (!a || !a.admin || a.exp < Date.now()) return adminLogin();
  if (p === '/admin/action' && req.method === 'POST') {
    const form = await req.formData(), act = form.get('a'), raw = normCode(form.get('code'));
    let msg = '';
    if (act === 'create') {
      const n = Math.min(10, Math.max(1, parseInt(form.get('n')) || 1)), max = Math.min(5, Math.max(1, parseInt(form.get('max')) || DEFAULT_MAX));
      const name = String(form.get('name') || '').slice(0, 60), made = [];
      for (let i = 0; i < n; i++) { let c; do { c = newCode(); } while (await getCode(env, c)); await putCode(env, c, { name: n > 1 && name ? `${name} #${i + 1}` : name, created: Date.now(), max, uses: [], revoked: false }); made.push(fmtCode(c)); }
      msg = `สร้างแล้ว: ${made.join(', ')}`;
    } else if (raw.length === 8) {
      const rec = await getCode(env, raw);
      if (rec) {
        if (act === 'revoke') { rec.revoked = true; await putCode(env, raw, rec); msg = `ยกเลิก ${fmtCode(raw)} แล้ว (มีผลภายใน 1 นาที)`; }
        if (act === 'restore') { rec.revoked = false; await putCode(env, raw, rec); msg = `เปิดใช้ ${fmtCode(raw)} อีกครั้งแล้ว`; }
        if (act === 'reset') { rec.uses = []; await putCode(env, raw, rec); msg = `ล้างเครื่องของ ${fmtCode(raw)} แล้ว (เครื่องเดิมต้องใส่รหัสใหม่)`; }
        if (act === 'delete') { await env.CODES.delete('code:' + raw); msg = `ลบ ${fmtCode(raw)} แล้ว`; }
        activeCache.clear();
      }
    }
    return adminPage(env, url, msg);
  }
  return adminPage(env, url);
}

/* ---------- data proxy: ผลรางวัลจากเว็บเดิม ---------- */
async function proxyData(path) {
  if (!/^\/data\/[a-z0-9_-]+\.json$/i.test(path)) return new Response('not found', { status: 404 });
  const r = await fetch(DATA_ORIGIN + path, { cf: { cacheTtl: 120, cacheEverything: true } });
  return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

/* ---------- main ---------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    if (p === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain' } });
    if (p === '/admin' || p.startsWith('/admin/')) return admin(req, env, url);
    if (p === '/api/redeem' && req.method === 'POST') return redeem(req, env);
    if (p === '/logout') return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': setCookie(SESSION_COOKIE, '', 0) } });

    const pub = PUBLIC_PATHS.has(p) || p.startsWith('/icons/');
    if (!pub) {
      const s = await verify(env, cookies(req)[SESSION_COOKIE]);
      const isPage = p === '/' || p === '/index.html' || req.headers.get('sec-fetch-mode') === 'navigate';
      let ok = !!(s && s.c && s.d);
      if (ok && (isPage || p.startsWith('/data/'))) ok = await codeActive(env, s.c, s.d); // ตรวจว่ารหัสยังไม่ถูกยกเลิก
      if (!ok) {
        if (isPage) return invitePage(url.searchParams.get('code') || '');
        return new Response('unauthorized', { status: 401, headers: { 'cache-control': 'no-store' } });
      }
      if (p.startsWith('/data/')) return proxyData(p);
    }
    const res = await env.ASSETS.fetch(req);
    const h = new Headers(res.headers);
    h.set('x-robots-tag', 'noindex, nofollow');
    if (!pub) h.set('cache-control', 'private, no-cache');
    return new Response(res.body, { status: res.status, headers: h });
  },
};
