// ดึง "เลขท้าย 3 ตัว" ย้อนหลังทุกงวดที่แอปมี → data/last3.json
//
//   node scripts/backfill-last3.mjs --probe   ทดลอง 6 งวด (3 จากกองสลาก + 3 จาก PPTV) ไม่เขียนไฟล์
//   node scripts/backfill-last3.mjs           ดึงจริง (~10–15 นาที) เฉพาะงวดที่ยังไม่มีในไฟล์
//
// แหล่งข้อมูล:
//   • ตั้งแต่ 1 มี.ค. 2553: สำนักงานสลากกินแบ่งรัฐบาล (POST glo.or.th/api/checking/getLotteryResult) ช่อง last3b
//   • ก่อน 1 มี.ค. 2553:  PPTV HD36 (pptvhd36.com/lotto/check?date=YYYY-MM-DD)
//     ยุคนั้นท้าย 3 ตัวออกงวดละ 4 เลข (ยังไม่มีเลขหน้า 3 ตัว) แต่ PPTV แสดงแบ่งเป็น "เลขหน้า 2 + ท้าย 2" จึงรวมทั้ง 4 เลข
// ตรวจความถูกต้อง: รางวัลที่ 1 จากแหล่งต้องตรงกับข้อมูลในแอป + จำนวนเลขต้องถูกตามยุค (4 เลขก่อน 1 ก.ย. 2558, หลังจากนั้น 2 เลข)
//                  + สุ่ม 12 งวดช่วง 2553–2558 มาเทียบระหว่างกองสลากกับ PPTV
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const FILE = 'data/last3.json', REPORT = 'scripts/last3-report.txt';
const PROBE = process.argv.includes('--probe');
const DELAY = +(process.env.LAST3_DELAY || 500);
const GLO_FROM = '20100301', SPLIT = '20150901'; // ตั้งแต่ 1 ก.ย. 2558 มีเลขหน้า 3 ตัว → ท้าย 3 ตัวเหลือ 2 เลข
const TH = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
const pad = n => String(n).padStart(2, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = { 'user-agent': 'Mozilla/5.0 (numora-backfill; personal non-commercial use)', 'accept-language': 'th' };

async function req(url, opt = {}, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { ...opt, headers: { ...UA, ...(opt.headers || {}) }, signal: AbortSignal.timeout(25000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) { if (i === tries) throw e; await sleep(2000 * i); }
  }
}

/* งวดทั้งหมดที่แอปมี: RAW ใน app.js + data/archive.json + data/draws.json → Map(key → รางวัลที่ 1) */
function allDraws() {
  const m = new Map();
  const app = readFileSync('app.js', 'utf8');
  const raw = (app.match(/"(\d{16}(?:;\d{16})+)"/) || [])[1];
  if (!raw) throw new Error('หา RAW ใน app.js ไม่เจอ');
  raw.split(';').forEach(s => m.set(s.slice(0, 8), s.slice(8, 14)));
  for (const f of ['data/archive.json', 'data/draws.json']) {
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, 'utf8'));
    (Array.isArray(j) ? j : j.draws || []).forEach(x => x && x.d && x.f && m.set(x.d, x.f));
  }
  return m;
}

async function fromGlo(k) {
  const body = JSON.stringify({ date: k.slice(6), month: k.slice(4, 6), year: k.slice(0, 4) });
  const t = await req('https://www.glo.or.th/api/checking/getLotteryResult', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const data = t && JSON.parse(t)?.response?.result?.data;
  if (!data) return { err: 'กองสลากไม่มีข้อมูลงวดนี้' };
  const first = data.first?.number?.[0]?.value;
  const b3 = (data.last3b?.number || []).sort((a, b) => a.round - b.round).map(x => String(x.value).trim()).filter(v => /^\d{3}$/.test(v));
  return { first, nums: b3, src: 'glo' };
}

const strip = html => html
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ')
  .replace(/<br\s*\/?>|<\/(p|div|li|span|td|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

async function fromPptv(k) {
  const html = await req(`https://www.pptvhd36.com/lotto/check?date=${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6)}`);
  if (!html) return { err: 'PPTV ไม่มีหน้านี้' };
  const flat = strip(html);
  let start = -1;
  for (const m of flat.matchAll(/งวดประจำวันที่\s*(\d{1,2})\s*([ก-๙]+)\s*(\d{4})/g)) {
    const mi = TH.indexOf(m[2]);
    if (mi >= 0 && `${+m[3] - 543}${pad(mi + 1)}${pad(+m[1])}` === k && flat.slice(m.index, m.index + 300).search(/รางวัลที่\s*1(?!\d)/) >= 0) { start = m.index; break; }
  }
  if (start < 0) return { err: 'ไม่พบหัวข้องวดนี้ในหน้า' };
  const after = flat.slice(start);
  const seg = (re, ends) => {
    const i = after.search(re); if (i < 0) return '';
    const rest = after.slice(i).replace(re, '');
    let j = rest.length; for (const e of ends) { const q = rest.search(e); if (q > 0 && q < j) j = q; }
    return rest.slice(0, j).replace(/มี\s*\d+\s*รางวัล/g, ' ').replace(/\d{1,3}(,\d{3})+/g, ' ');
  };
  const NEXT = [/เลขหน้า\s*3\s*ตัว/, /เลขท้าย\s*3\s*ตัว/, /เลขท้าย\s*2\s*ตัว/, /ข้างเคียง/, /รางวัลที่\s*[2-5]/];
  const s1 = seg(/รางวัลที่\s*1(?!\d)/, NEXT);
  let first = (s1.match(/(?:^|\D)(\d{6})(?!\d)/) || [])[1];
  if (!first) { const m = s1.match(/(?:^|\D)(\d)\s+(\d)\s+(\d)\s+(\d)\s+(\d)\s+(\d)(?!\d)/); if (m) first = m.slice(1, 7).join(''); }
  const three = s => [...s.matchAll(/(?:^|\D)(\d{3})(?!\d)/g)].map(x => x[1]);
  const front = three(seg(/เลขหน้า\s*3\s*ตัว/, NEXT.filter((_, i) => i !== 0)));
  const back = three(seg(/เลขท้าย\s*3\s*ตัว/, NEXT.filter((_, i) => i !== 1)));
  const nums = k < SPLIT ? [...front, ...back] : back; // ก่อน ก.ย. 2558: 4 เลขทั้งหมดคือท้าย 3 ตัว
  return { first, nums, src: 'pptv' };
}

const expectN = k => (k < SPLIT ? 4 : 2);

async function main() {
  const draws = allDraws();
  const keys = [...draws.keys()].sort();
  const db = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { draws: {} };
  const log = [], bad = [];
  let todo = keys.filter(k => !db.draws[k]);
  if (PROBE) todo = [...keys.filter(k => k >= GLO_FROM).slice(0, 2), '20151016', ...keys.filter(k => k < GLO_FROM).slice(0, 2), '20050316'].filter(k => draws.has(k));
  console.log(`งวดทั้งหมด ${keys.length} · ต้องดึง ${todo.length}${PROBE ? ' (ทดลอง)' : ''}`);
  let n = 0;
  for (const k of todo) {
    n++;
    let r;
    try { r = k >= GLO_FROM ? await fromGlo(k) : await fromPptv(k); }
    catch (e) { r = { err: e.message }; }
    if (!r.err && k >= GLO_FROM && r.nums.length !== expectN(k)) { // สำรอง: ถ้ากองสลากให้ไม่ครบ ลอง PPTV
      try { const p = await fromPptv(k); if (!p.err && p.nums.length === expectN(k)) r = p; } catch {}
    }
    let msg;
    if (r.err) msg = `ข้าม: ${r.err}`;
    else if (r.first !== draws.get(k)) msg = `ข้าม: รางวัลที่ 1 ไม่ตรง (แหล่ง=${r.first} แอป=${draws.get(k)})`;
    else if (r.nums.length !== expectN(k)) msg = `ข้าม: ได้ ${r.nums.length} เลข (ควรได้ ${expectN(k)})`;
    else { db.draws[k] = r.nums; msg = `ok ${r.nums.join(',')} (${r.src})`; }
    if (msg.startsWith('ข้าม')) bad.push(`${k} ${msg}`);
    log.push(`${k} ${msg}`);
    if (PROBE || n % 25 === 0 || msg.startsWith('ข้าม')) console.log(`  [${n}/${todo.length}] ${k} ${msg}`);
    if (!PROBE && n % 50 === 0) save(db);
    await sleep(DELAY);
  }
  // เทียบสองแหล่ง: สุ่ม 12 งวดช่วง 2553–2558 (มีทั้งในกองสลากและ PPTV)
  const cross = [];
  if (!PROBE) {
    const pool = keys.filter(k => k >= GLO_FROM && k < SPLIT && db.draws[k]);
    for (let i = 0; i < Math.min(12, pool.length); i++) {
      const k = pool[Math.floor((i + 0.5) * pool.length / 12)];
      try {
        const p = await fromPptv(k);
        const same = !p.err && [...p.nums].sort().join() === [...db.draws[k]].sort().join();
        cross.push(`${k} ${same ? 'ตรง' : 'ไม่ตรง'} กองสลาก=${db.draws[k].join(',')} PPTV=${p.err || p.nums.join(',')}`);
      } catch (e) { cross.push(`${k} PPTV error ${e.message}`); }
      await sleep(DELAY);
    }
    save(db);
  }
  const have = keys.filter(k => db.draws[k]).length;
  const summary = [`มีท้าย 3 ตัว ${have}/${keys.length} งวด`, `ข้าม ${bad.length} งวด`, ...(cross.length ? [`เทียบกองสลากกับ PPTV: ตรง ${cross.filter(c => c.includes(' ตรง ')).length}/${cross.length}`] : [])];
  console.log('\n' + summary.join('\n'));
  if (bad.length) console.log('งวดที่ข้าม:\n  ' + bad.join('\n  '));
  if (cross.length) console.log('เทียบสองแหล่ง:\n  ' + cross.join('\n  '));
  if (!PROBE) writeFileSync(REPORT, [...summary, '', 'งวดที่ข้าม:', ...bad, '', 'เทียบสองแหล่ง:', ...cross, '', 'บันทึกทั้งหมด:', ...log].join('\n'));
}

function save(db) {
  db.note = 'เลขท้าย 3 ตัวของทุกงวด (ก่อน 1 ก.ย. 2558 ออกงวดละ 4 เลข หลังจากนั้น 2 เลข)';
  db.source = 'ตั้งแต่ มี.ค. 2553: สำนักงานสลากกินแบ่งรัฐบาล (glo.or.th) · ก่อนหน้านั้น: PPTV HD36';
  db.generatedAt = new Date().toISOString();
  db.draws = Object.fromEntries(Object.entries(db.draws).sort((a, b) => b[0].localeCompare(a[0])));
  writeFileSync(FILE, JSON.stringify(db));
}

main().catch(e => { console.error(e); process.exit(1); });
