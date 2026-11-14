// ดึง "เลขเด็ด" จากบทความชุด "หวยแม่จำเนียร 10 อันดับเลขขายดี" ของ Sanook (sanook.com/news/tag/หวยแม่จำเนียร/)
// เก็บเฉพาะเลข 2 ตัว + ชื่อสำนัก/แหล่ง + ลิงก์ต้นทาง ลง data/tips.json (ไม่เก็บเนื้อหาบทความ)
// ใช้: node scripts/update-tips.mjs          → เพิ่มงวดใหม่ + ดึงงวดที่ยังไม่ออกซ้ำ
//      node scripts/update-tips.mjs --all    → ดึงทุกบทความในหน้า tag ใหม่หมด
//      node scripts/update-tips.mjs --probe  → แสดงผล ไม่เขียนไฟล์
import fs from 'node:fs';

const FILE = 'data/tips.json';
const TAG = 'https://www.sanook.com/news/tag/%E0%B8%AB%E0%B8%A7%E0%B8%A2%E0%B9%81%E0%B8%A1%E0%B9%88%E0%B8%88%E0%B8%B3%E0%B9%80%E0%B8%99%E0%B8%B5%E0%B8%A2%E0%B8%A3/';
const UA = 'Mozilla/5.0 (compatible; NumoraBot/1.0; +https://thapthimchuea.github.io/numora/)';
const args = process.argv.slice(2);
const PROBE = args.includes('--probe'), ALL = args.includes('--all');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'th,en;q=0.8' }, signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.text();
      console.log(`  HTTP ${r.status} ${url}`);
    } catch (e) { console.log(`  ${e.message} ${url}`); }
    await sleep(1500 * (i + 1));
  }
  return null;
}

const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const MONTHS_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const esc = s => s.replace(/\./g, '\\.');
const MON_RE = `(${[...MONTHS_FULL, ...MONTHS].map(esc).join('|')})`;
const toYear = y => { y = +y; if (y < 100) y += 2500; if (y > 2400) y -= 543; return y; };

export function drawKeyFromTitle(t) {
  let m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return toYear(m[3]) * 10000 + +m[2] * 100 + +m[1];
  m = t.match(new RegExp(`(\\d{1,2})\\s*${MON_RE}\\s*(\\d{2,4})`));
  if (m) { const i = MONTHS_FULL.indexOf(m[2]); const mo = (i >= 0 ? i : MONTHS.indexOf(m[2])) + 1; return toYear(m[3]) * 10000 + mo * 100 + +m[1]; }
  return null;
}
const validDraw = k => { const d = k % 100, mo = Math.floor(k / 100) % 100; return mo >= 1 && mo <= 12 && [1, 2, 16, 17, 30, 31].includes(d); };

const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const text = s => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
// ตัดส่วนที่เป็นวันที่/อายุ/ปี ออกก่อนดึงเลข 2 ตัว เพื่อไม่ให้ได้เลขผิด
const cleanNums = s => s
  .replace(new RegExp(`\\d{1,2}\\s*${MON_RE}\\s*\\d{2,4}`, 'g'), ' ')
  .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, ' ')
  .replace(/(อายุ|ครบรอบ|ครั้งที่|รุ่นที่|พ\.ศ\.|ค\.ศ\.|ปี|พรรษา|ชั้น|รอบ|อันดับ|ที่|คนที่)\s*\d+/g, ' ')
  .replace(/\d+\s*(อันดับ|เลขขายดี|เลขเด็ด)/g, ' ')
  .replace(/\d+\s*(ปี|พรรษา|วัน|นาที|ชั่วโมง|ล้าน|บาท|คน|องค์|เมตร|กม\.|%)/g, ' ');
export const nums2 = s => [...new Set([...cleanNums(s).matchAll(/(?<![\d.\-\/:])\d{2}(?![\d.\-\/:])/g)].map(x => +x[0]))];

export function parseArticle(html) {
  // เนื้อหาเริ่มที่หัวข้อ h2/h3 แรก จบก่อนส่วน "คลิกตรวจหวย" / แท็ก
  let start = html.search(/<h[23][^>]*>/);
  if (start < 0) start = 0;
  let body = html.slice(start);
  const end = body.search(/คลิกตรวจหวย|ข่าวที่เกี่ยวข้อง|แชร์เรื่องนี้/);
  if (end > 0) body = body.slice(0, end);
  const top = [], entries = [];
  let section = '';
  // ตาราง 10 อันดับ (บางงวดทำเป็นตาราง: ช่องอันดับ | ช่องเลข)
  for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const c = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(x => text(x[1]));
    if (c.length >= 2 && /^\d{1,2}$/.test(c[0]) && /^\d{2}$/.test(c[1]) && top.length < 10) top.push(+c[1]);
  }
  const SKIP_NAME = /ตรวจหวย|งวดประจำวันที่|แนวทางหวยงวดนี้|10 เลข|10 อันดับ|^"?เลขเด็ด"?$|คลิก|อ่านเพิ่ม/;
  for (const m of body.matchAll(/<(h[23]|li|p)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const tag = m[1], inner = m[2];
    if (tag !== 'li' && tag !== 'p' ) { section = text(inner); continue; }
    const strong = (inner.match(/<strong>([\s\S]*?)<\/strong>/) || [])[1];
    const t = text(inner);
    if (!t || t.length > 400) continue;
    const isTop = /อันดับ|ขายดี/.test(section) && !/สำนัก|มงคล/.test(section);
    // แบบ "อันดับ 1 : 88" หรือ "<strong>15:</strong> เลขขายดีอันดับ 1 ..."
    const rank = t.match(/^อันดับ\s*(\d+)\s*(?:[:：]|เลข)\s*(\d{2})(?!\d)/) || (strong && /^\s*\d{2}\s*[:：]?\s*$/.test(text(strong)) && /อันดับ\s*\d+/.test(t) ? [null, (t.match(/อันดับ\s*(\d+)/) || [])[1], text(strong).replace(/\D/g, '')] : null);
    if (rank && rank[2]) { if (top.length < 10) top.push(+rank[2]); continue; }
    if (isTop && tag === 'p' && !strong) continue;
    let name, val;
    if (strong && text(strong).replace(/[:：\s]/g, '').length > 1 && !/^\d+$/.test(text(strong).replace(/[:：\s,]/g, ''))) {
      name = text(strong).replace(/\s*[:：]\s*$/, ''); val = t.slice(text(strong).length);
    } else if (t.includes(':')) {
      const i = t.indexOf(':'); name = t.slice(0, i); val = t.slice(i + 1);
    } else if (tag === 'li' && /ให้เลข|เลขเด่น/.test(t)) {
      const i = t.search(/ให้เลข|เลขเด่น/); name = t.slice(0, i); val = t.slice(i);
    } else continue;
    name = name.replace(/[:：\s]+$/, '').trim();
    if (!name || name.length > 60 || /^\d/.test(name) || SKIP_NAME.test(name)) continue;
    const n = nums2(val);
    if (n.length && n.length <= 20) entries.push({ name, nums: n });
  }
  return { top, entries };
}

async function main() {
  const db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { note: '', source: '', updatedAt: null, draws: {} };
  db.note = 'เลขเด็ดจากบทความหวยแม่จำเนียรของ Sanook เก็บเฉพาะเลข 2 ตัว ชื่อแหล่ง และลิงก์ เพื่อทดสอบความแม่นยำ ไม่ใช่คำแนะนำ';
  db.source = 'https://www.sanook.com/news/tag/หวยแม่จำเนียร/';
  const tag = await get(TAG);
  if (!tag) { console.log('ดึงหน้า tag ไม่ได้'); process.exit(PROBE ? 1 : 0); }
  const links = [...new Set([...tag.matchAll(/https:\/\/www\.sanook\.com\/news\/(\d{7,})\//g)].map(m => m[0]))];
  console.log(`พบ ${links.length} ลิงก์ในหน้า tag`);
  const todayKey = (() => { const d = new Date(Date.now() + 7 * 3600e3); return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); })();
  let changed = 0;
  for (const url of links.slice(0, 30)) {
    const known = Object.entries(db.draws).find(([, v]) => v.url === url);
    if (known && !ALL && +known[0] < todayKey) continue; // งวดที่ออกแล้ว ไม่ต้องดึงซ้ำ
    const html = await get(url); await sleep(800);
    if (!html) continue;
    const title = text((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    if (!/แม่จำเนียร/.test(title)) continue;
    const key = drawKeyFromTitle(title);
    if (!key || !validDraw(key)) { console.log(`  ข้าม (หาวันงวดไม่ได้): ${title.slice(0, 60)}`); continue; }
    if (db.draws[key] && db.draws[key].url !== url && !ALL) continue; // มีบทความใหม่กว่าของงวดนี้แล้ว
    const p = parseArticle(html);
    const n = p.entries.length + (p.top.length ? 1 : 0);
    console.log(`  ${key}  top10=${p.top.join(',') || '-'}  แหล่ง ${p.entries.length}  ${title.slice(0, 50)}`);
    if (!n) continue;
    if (PROBE) { p.entries.forEach(e => console.log(`      ${e.name}: ${e.nums.join(', ')}`)); continue; }
    const rec = { url, title: title.slice(0, 160), top: p.top, entries: p.entries, fetchedAt: new Date().toISOString() };
    const prev = db.draws[key];
    if (!prev || JSON.stringify([prev.top, prev.entries]) !== JSON.stringify([rec.top, rec.entries])) { db.draws[key] = rec; changed++; }
  }
  if (PROBE) return;
  db.draws = Object.fromEntries(Object.entries(db.draws).sort((a, b) => b[0] - a[0]).slice(0, 120));
  if (changed) { db.updatedAt = new Date().toISOString(); fs.writeFileSync(FILE, JSON.stringify(db, null, 1)); }
  console.log(changed ? `บันทึก ${changed} งวด → ${FILE}` : 'ไม่มีข้อมูลใหม่');
}
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('update-tips.mjs')) main();
