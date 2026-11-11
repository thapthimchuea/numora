// ดึงผลสลากงวดใหม่จาก lotto.api.rayriffy.com แล้วบันทึกลง data/draws.json
// รันโดย GitHub Actions (.github/workflows/update-draws.yml) ไม่ต้องรันเอง
import { readFileSync, writeFileSync } from 'node:fs';

const API = 'https://lotto.api.rayriffy.com';
const FILE = 'data/draws.json';
const BASE_LATEST = '20261101'; // งวดล่าสุดที่ฝังอยู่ในแอปแล้ว (1 พ.ย. 2569)
const MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
const SHORT = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
const pad = n => String(n).padStart(2, '0');

function toKey(str) {
  if (!str) return null;
  str = String(str).trim();
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) { let y = +m[1]; if (y > 2400) y -= 543; return `${y}${m[2]}${m[3]}`; }
  m = str.match(/(\d{1,2})\s*([ก-๙.]+)\s*(\d{4})/);
  if (m) {
    let mi = MONTHS.indexOf(m[2]); if (mi < 0) mi = SHORT.indexOf(m[2]);
    if (mi >= 0) { let y = +m[3]; if (y > 2400) y -= 543; return `${y}${pad(mi + 1)}${pad(+m[1])}`; }
  }
  m = str.match(/(\d{2})(\d{2})(\d{4})/);
  if (m && +m[2] >= 1 && +m[2] <= 12) { let y = +m[3]; if (y > 2400) y -= 543; return `${y}${m[2]}${m[1]}`; }
  return null;
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'numora-updater (github actions)' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function parse(json, hint) {
  const r = json && (json.response || json);
  if (!r) return null;
  const d = toKey(r.date) || toKey(r.endpoint) || toKey(hint);
  const pick = (list, id) => (Array.isArray(list) ? list.find(x => x && x.id === id) : null);
  const f = String((pick(r.prizes, 'prizeFirst')?.number || [])[0] ?? '').trim();
  const l = String((pick(r.runningNumbers, 'runningNumberBackTwo')?.number || [])[0] ?? '').trim();
  if (!d || !/^\d{6}$/.test(f) || !/^\d{1,2}$/.test(l)) return null; // ผลยังออกไม่ครบ / รูปแบบผิด
  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  if (d > today) return null;
  return { d, f, l: l.padStart(2, '0') };
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
data.draws = Array.isArray(data.draws) ? data.draws : [];
const known = new Set(data.draws.map(x => x.d));
const latestKnown = [BASE_LATEST, ...known].sort().pop();
let added = [];

try {
  const latestJson = await getJSON(`${API}/latest`);
  console.log('API /latest date:', latestJson?.response?.date);
  const latest = parse(latestJson);
  if (!latest) console.log('ผลงวดล่าสุดยังออกไม่ครบ หรือรูปแบบข้อมูลเปลี่ยน — ยังไม่บันทึก');
  else if (latest.d > latestKnown && !known.has(latest.d)) {
    added.push(latest);
    // เก็บงวดที่ตกหล่น (ถ้ามี)
    try {
      const list = await getJSON(`${API}/list/1`);
      const items = Array.isArray(list?.response) ? list.response : [];
      for (const it of items.slice(0, 8)) {
        const k = toKey(it.date) || toKey(it.id);
        if (!k || k <= latestKnown || k >= latest.d || known.has(k)) continue;
        try { const d = parse(await getJSON(`${API}/lotto/${it.id}`), it.id); if (d) added.push(d); } catch (e) { console.log('skip', it.id, e.message); }
      }
    } catch (e) { console.log('list skipped:', e.message); }
  } else console.log('ไม่มีงวดใหม่ (ล่าสุดในแอป:', latestKnown + ')');
} catch (e) {
  console.log(`::warning::ดึงข้อมูลจาก API ไม่ได้: ${e.message}`);
  data.lastCheck = { at: new Date().toISOString(), ok: false, error: e.message };
  writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
  process.exit(0);
}

data.lastCheck = { at: new Date().toISOString(), ok: true };
if (added.length) {
  data.draws = [...data.draws, ...added].sort((a, b) => b.d.localeCompare(a.d));
  data.updatedAt = new Date().toISOString();
  console.log('เพิ่มงวดใหม่:', added.map(x => `${x.d} ${x.f} ${x.l}`).join(', '));
}
writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
