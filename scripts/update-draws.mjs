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

async function gloLatest() {
  const res = await http('https://www.glo.or.th/api/lottery/getLatestLottery', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const json = await res.json();
  const r = fromGloJson(json);
  if (!r) console.log('GLO latest: แปลงข้อมูลไม่ได้ ตัวอย่างข้อมูลดิบ:', JSON.stringify(json).slice(0, 600));
  return r;
}
async function gloByDate(k) {
  const body = JSON.stringify({ date: k.slice(6), month: k.slice(4, 6), year: k.slice(0, 4) });
  const res = await http('https://www.glo.or.th/api/checking/getLotteryResult', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const json = await res.json();
  const r = fromGloJson(json);
  if (r && r.d !== k) return null;
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
  return { d: k, f: f[1], l: l[1] };
}

async function tryIt(name, fn) {
  try { const r = await fn(); console.log(`  ${name}:`, r ? `${r.d} ${r.f} ${r.l}` : 'ยังไม่มีผล'); return r; }
  catch (e) { console.log(`  ${name}: ไม่สำเร็จ (${e.message})`); return undefined; }
}

/* ---------------- main ---------------- */
const data = JSON.parse(readFileSync(FILE, 'utf8'));
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
  console.log(`  -> บันทึก ${k}: ${first[1].f} / ${first[1].l} (${results.map(([n]) => n).join(' + ')})`);
}

if (due.length === 0 && latest) console.log('GLO รายงานงวดล่าสุดคือ', latest.d, '— แหล่งข้อมูลใช้งานได้');
if (!anySourceOk) console.log('::warning::เชื่อมต่อแหล่งข้อมูลไม่ได้เลยในรอบนี้');

data.lastCheck = { at: new Date().toISOString(), ok: anySourceOk };
if (added.length) {
  data.draws = [...data.draws, ...added.map(({ d, f, l }) => ({ d, f, l }))].sort((a, b) => b.d.localeCompare(a.d));
  data.updatedAt = new Date().toISOString();
}
if (DRY) console.log('[dry-run] ไม่เขียนไฟล์');
else writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
