// ดึงผลสลากงวดใหม่ แล้วบันทึกลง data/draws.json (รันโดย GitHub Actions ไม่ต้องรันเอง)
//
// แหล่งข้อมูล (ลองตามลำดับ และตรวจเทียบกันถ้าได้มากกว่า 1 แหล่ง):
//   1) API ทางการของสำนักงานสลากกินแบ่งรัฐบาล (GLO Data Catalog)
//      POST https://www.glo.or.th/api/lottery/getLatestLottery
//      POST https://www.glo.or.th/api/checking/getLotteryResult  {date, month, year}
//   2) หน้าผลรางวัลของ The Thaiger  https://thethaiger.com/thai-lottery/DD-MM-YYYY
//
// ทดสอบได้โดยไม่เขียนไฟล์:  node scripts/update-draws.mjs --dry-run
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'data/draws.json';
const PRIZE_FILE = 'data/prizes.json';
const PRIZE_COUNTS = { first: 1, near1: 2, second: 5, third: 10, fourth: 50, fifth: 100, last3f: 2, last3b: 2, last2: 1 };
const BASE_LATEST = '20261101'; // งวดล่าสุดที่ฝังอยู่ในแอปแล้ว (1 พ.ย. 2569)
const DRY = process.argv.includes('--dry-run');
const UA = 'Mozilla/5.0 (compatible; numora-updater; +https://github.com)';
const TH_FULL = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
const TH_SHORT = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
const EN = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const pad = n => String(n).padStart(2, '0');
const ce = y => (y > 2400 ? y - 543 : y);
const keyOf = (y, m, d) => `${ce(+y)}${pad(+m)}${pad(+d)}`;
const todayBKK = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');

/* วันที่หลายรูปแบบ -> 'YYYYMMDD' (ค.ศ.) */
function toKey(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    const d = v.date ?? v.day, m = v.month, y = v.year;
    if (d && m && y && !isNaN(+d) && !isNaN(+m)) return keyOf(y, m, d);
    return null;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);                 if (m) return keyOf(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);           if (m) return keyOf(m[3], m[2], m[1]);
  m = s.match(/(\d{1,2})\s*([ก-๙.]+)\s*(?:พ\.ศ\.\s*)?(\d{4})/);
  if (m) { let i = TH_FULL.indexOf(m[2]); if (i < 0) i = TH_SHORT.indexOf(m[2]); if (i >= 0) return keyOf(m[3], i + 1, m[1]); }
  m = s.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m) { const i = EN.indexOf(m[2].toLowerCase()); if (i >= 0) return keyOf(m[3], i + 1, m[1]); }
  return null;
}

/* ตารางวันออกรางวัล: 1 และ 16 ของเดือน ยกเว้น 17 ม.ค., 2 พ.ค., 30 ธ.ค. */
function nextDraw(k) {
  const y = +k.slice(0, 4), m = +k.slice(4, 6), d = +k.slice(6);
  if (m === 12 && d >= 30) return keyOf(y + 1, 1, 17);
  if (m === 12 && d >= 16) return keyOf(y, 12, 30);
  if (d < 16) return keyOf(y, m, 16);
  const nm = m === 12 ? 1 : m + 1, ny = m === 12 ? y + 1 : y;
  return keyOf(ny, nm, nm === 5 ? 2 : 1);
}

async function http(url, opt = {}) {
  const res = await fetch(url, { ...opt, headers: { 'user-agent': UA, accept: 'application/json, text/html;q=0.9', ...(opt.headers || {}) }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

/* ---- ค้นหาค่าในโครง JSON แบบไม่ผูกกับรูปแบบตายตัว ---- */
function findKey(node, names, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return undefined;
  for (const n of names) if (Object.prototype.hasOwnProperty.call(node, n)) return node[n];
  for (const v of Object.values(node)) { const r = findKey(v, names, depth + 1); if (r !== undefined) return r; }
  return undefined;
}
const SKIP = new Set(['round', 'price', 'reward', 'amount', 'id', 'order', 'seq', 'count', 'status', 'statusCode']);
function firstMatch(node, re, depth = 0) {
  if (node == null || depth > 8) return null;
  if (typeof node === 'string' || typeof node === 'number') { const s = String(node).trim(); return re.test(s) ? s : null; }
  if (typeof node === 'object') {
    // ให้ความสำคัญกับช่อง value / number ก่อน และข้ามช่องอย่าง round, price
    const entries = Object.entries(node).filter(([k]) => !SKIP.has(k))
      .sort(([a], [b]) => (/^(value|number)$/.test(b) ? 1 : 0) - (/^(value|number)$/.test(a) ? 1 : 0));
    for (const [, v] of entries) { const r = firstMatch(v, re, depth + 1); if (r) return r; }
  }
  return null;
}
function fromGloJson(json) {
  const f = firstMatch(findKey(json, ['first']), /^\d{6}$/);
  const l = firstMatch(findKey(json, ['last2']), /^\d{1,2}$/);
  const d = toKey(findKey(json, ['date'])) || toKey(findKey(json, ['displayDate'])) || toKey(findKey(json, ['drawDate', 'period_date']));
  if (!d || !f || !l) return null;
  return { d, f, l: l.padStart(2, '0') };
}

function collectAll(node, re, out = [], depth = 0) {
  if (node == null || depth > 8) return out;
  if (typeof node === 'string' || typeof node === 'number') { const v = String(node).trim(); if (re.test(v)) out.push(v); return out; }
  if (typeof node === 'object') for (const [k, v] of Object.entries(node)) if (!SKIP.has(k)) collectAll(v, re, out, depth + 1);
  return out;
}
/* รางวัลครบทุกระดับจาก JSON ของ GLO — เก็บเฉพาะหมวดที่จำนวนครบถูกต้อง */
function fullFromGlo(json) {
  const out = {};
  for (const [k, n] of Object.entries(PRIZE_COUNTS)) {
    const re = k === 'last2' ? /^\d{1,2}$/ : k.startsWith('last3') ? /^\d{3}$/ : /^\d{6}$/;
    let vals = collectAll(findKey(json, [k]), re).map(v => (k === 'last2' ? v.padStart(2, '0') : v));
    vals = [...new Set(vals)];
    if (vals.length === n || (k.startsWith('last3') && vals.length === 1)) out[k] = vals;
  }
  return out;
}
/* รางวัลครบทุกระดับจากข้อความหน้า The Thaiger */
function fullFromThaigerText(text) {
  const grab = (re, n, w) => { const m = text.match(re); if (!m) return []; return (text.slice(m.index + m[0].length).match(new RegExp(`\\b\\d{${w}}\\b`, 'g')) || []).slice(0, n); };
  const out = {
    first: grab(/1st prize/i, 1, 6), last2: grab(/last 2 digits/i, 1, 2),
    last3f: grab(/first 3 digits/i, 2, 3), last3b: grab(/last 3 digits/i, 2, 3),
    near1: grab(/results,\s*side 1st prize/i, 2, 6), second: grab(/results,\s*2nd prize/i, 5, 6),
    third: grab(/results,\s*3rd prize/i, 10, 6), fourth: grab(/results,\s*4th prize/i, 50, 6), fifth: grab(/results,\s*5th prize/i, 100, 6),
  };
  for (const k of Object.keys(out)) if (out[k].length !== PRIZE_COUNTS[k]) delete out[k];
  return out;
}
const fullCount = p => Object.keys(PRIZE_COUNTS).filter(k => p && p[k]).length;

async function gloLatest() {
  const res = await http('https://www.glo.or.th/api/lottery/getLatestLottery', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const json = await res.json();
  const r = fromGloJson(json);
  if (!r) console.log('GLO latest: แปลงข้อมูลไม่ได้ ตัวอย่างข้อมูลดิบ:', JSON.stringify(json).slice(0, 600));
  if (r) { r.full = fullFromGlo(json); if (fullCount(r.full) < 9) console.log(`  (GLO ให้รางวัลครบ ${fullCount(r.full)}/9 หมวด) ตัวอย่างข้อมูล:`, JSON.stringify(json).slice(0, 400)); }
  return r;
}
async function gloByDate(k) {
  const body = JSON.stringify({ date: k.slice(6), month: k.slice(4, 6), year: k.slice(0, 4) });
  const res = await http('https://www.glo.or.th/api/checking/getLotteryResult', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const json = await res.json();
  const r = fromGloJson(json);
  if (r && r.d !== k) return null;
  if (r) r.full = fullFromGlo(json);
  return r;
}
async function thaiger(k) {
  const url = `https://thethaiger.com/thai-lottery/${k.slice(6)}-${k.slice(4, 6)}-${k.slice(0, 4)}`;
  const html = await (await http(url)).text();
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const head = text.match(/Government Lottery Results\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/);
  if (!head || toKey(head[1]) !== k) return null;
  const f = text.match(/1st prize\s*(\d{6})\b/i);
  const l = text.match(/last 2 digits\s*(\d{2})\b/i);
  if (!f || !l) return null; // ผลยังไม่ออก (มักแสดงเป็น xxxxxx)
  return { d: k, f: f[1], l: l[1], full: fullFromThaigerText(text) };
}

async function tryIt(name, fn) {
  try { const r = await fn(); console.log(`  ${name}:`, r ? `${r.d} ${r.f} ${r.l}` : 'ยังไม่มีผล'); return r; }
  catch (e) { console.log(`  ${name}: ไม่สำเร็จ (${e.message})`); return undefined; }
}

/* ---------------- main ---------------- */
const data = JSON.parse(readFileSync(FILE, 'utf8'));
let prizes = { draws: {} };
try { prizes = JSON.parse(readFileSync(PRIZE_FILE, 'utf8')); prizes.draws = prizes.draws || {}; } catch (e) { console.log('ยังไม่มี', PRIZE_FILE, '— จะสร้างใหม่'); }
let prizesChanged = false;
function savePrizes(k, results) {
  // ใช้แหล่งที่ให้หมวดรางวัลครบที่สุด และต้องมีรางวัลที่ 1 ตรงกับผลที่ยืนยันแล้ว
  const best = results.map(([n, r]) => [n, r.full || {}]).sort((a, b) => fullCount(b[1]) - fullCount(a[1]))[0];
  if (!best) return;
  const cur = prizes.draws[k] || {};
  if (fullCount(best[1]) <= fullCount(cur)) return;
  prizes.draws[k] = { ...cur, ...best[1] };
  prizesChanged = true;
  console.log(`  -> รางวัลครบ ${fullCount(prizes.draws[k])}/9 หมวด (${best[0]})`);
}
data.draws = Array.isArray(data.draws) ? data.draws : [];
const known = new Set(data.draws.map(x => x.d));
let cursor = [BASE_LATEST, ...known].sort().pop();
const today = todayBKK();
const added = [];
let anySourceOk = false;

// งวดที่ควรมีผลแล้วแต่ยังไม่มีในไฟล์ (จำกัด 6 งวด)
const due = [];
for (let k = nextDraw(cursor); k <= today && due.length < 6; k = nextDraw(k)) due.push(k);
console.log('งวดล่าสุดในแอป:', cursor, '| งวดที่รอผล:', due.length ? due.join(', ') : '(ไม่มี — ยังไม่ถึงวันออกรางวัลถัดไป ' + nextDraw(cursor) + ')');

// เรียก GLO latest ครั้งเดียว ใช้เทียบได้ทุกงวด
console.log('ตรวจแหล่งข้อมูล GLO (งวดล่าสุด)');
const latest = await tryIt('GLO getLatestLottery', gloLatest);
if (latest !== undefined) anySourceOk = true;

for (const k of due) {
  console.log(`งวด ${k}`);
  const results = [];
  if (latest && latest.d === k) results.push(['GLO latest', latest]);
  else { const r = await tryIt('GLO getLotteryResult', () => gloByDate(k)); if (r !== undefined) anySourceOk = true; if (r) results.push(['GLO by date', r]); }
  const t = await tryIt('Thaiger', () => thaiger(k)); if (t !== undefined) anySourceOk = true; if (t) results.push(['Thaiger', t]);

  if (!results.length) { console.log('  -> ยังไม่มีผลจากแหล่งใด'); continue; }
  const [first, ...rest] = results;
  const conflict = rest.find(([, r]) => r.f !== first[1].f || r.l !== first[1].l);
  if (conflict) { console.log(`::warning::ผลงวด ${k} ไม่ตรงกัน: ${first[0]}=${first[1].f}/${first[1].l} vs ${conflict[0]}=${conflict[1].f}/${conflict[1].l} — ยังไม่บันทึก`); continue; }
  added.push({ ...first[1], src: results.map(([n]) => n).join('+') });
  savePrizes(k, results);
  console.log(`  -> บันทึก ${k}: ${first[1].f} / ${first[1].l} (${results.map(([n]) => n).join(' + ')})`);
}

// เติมรางวัลให้ครบสำหรับงวดใหม่ที่มีแล้วแต่ข้อมูลรางวัลยังไม่ครบ (สูงสุด 3 งวด)
for (const k of [...known].sort().reverse().slice(0, 3)) {
  if (fullCount(prizes.draws[k]) === 9) continue;
  console.log(`เติมข้อมูลรางวัลงวด ${k}`);
  const results = [];
  if (latest && latest.d === k) results.push(['GLO latest', latest]);
  const t = await tryIt('Thaiger', () => thaiger(k)); if (t) results.push(['Thaiger', t]);
  const known1 = data.draws.find(x => x.d === k);
  savePrizes(k, results.filter(([, r]) => !known1 || r.f === known1.f));
}

if (due.length === 0 && latest) console.log('GLO รายงานงวดล่าสุดคือ', latest.d, '— แหล่งข้อมูลใช้งานได้');
if (!anySourceOk) console.log('::warning::เชื่อมต่อแหล่งข้อมูลไม่ได้เลยในรอบนี้');

data.lastCheck = { at: new Date().toISOString(), ok: anySourceOk };
if (added.length) {
  data.draws = [...data.draws, ...added.map(({ d, f, l }) => ({ d, f, l }))].sort((a, b) => b.d.localeCompare(a.d));
  data.updatedAt = new Date().toISOString();
}
if (DRY) console.log('[dry-run] ไม่เขียนไฟล์');
else {
  writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
  if (prizesChanged) writeFileSync(PRIZE_FILE, JSON.stringify(prizes));
}
