// ดึงผลสลากย้อนหลัง 16 ก.ย. 2542 – ก.พ. 2553 (งวดที่เก่ากว่าข้อมูลที่ฝังในแอป) → data/archive.json
//
// รันครั้งเดียวบนคอม (ต้องใช้ Node 18 ขึ้นไป):
//   node scripts/backfill-archive.mjs --probe     ทดลองอ่าน 3 หน้า แล้วแสดงผลให้ตรวจก่อน
//   node scripts/backfill-archive.mjs --extra     เติมงวดที่อาจขาด (30–31 ธ.ค. ของทุกปี) ลงใน data/archive.json ที่มีอยู่
//   node scripts/backfill-archive.mjs             ดึงจริง (~10–15 นาที) เขียน data/archive.json + scripts/backfill-report.txt
//
// แหล่งข้อมูล: หน้าผลสลากรายงวดของ PPTV (pptvhd36.com/lotto/check?date=YYYY-MM-DD)
// ตรวจความถูกต้อง: (1) ข้างเคียงรางวัลที่ 1 ต้องเท่ากับรางวัลที่ 1 ±1
//                  (2) เทียบเลขท้าย 2 ตัวกับชุดข้อมูล Hugging Face ANTDPU/ThaiGovernmentLotteryResults (MIT)
//                  (3) ดึง 40 งวดที่เรารู้ผลแน่นอนแล้ว มาวัดความแม่นของแหล่งข้อมูล
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

const BASE = 'https://www.pptvhd36.com/lotto/check?date=';
const HF_CSV = 'https://huggingface.co/datasets/ANTDPU/ThaiGovernmentLotteryResults/resolve/main/lotto.csv';
const START = process.env.BACKFILL_START || '1999-09-01', END = process.env.BACKFILL_END || '2010-02-28'; // ข้อมูลในแอปเริ่ม 1 มี.ค. 2553 (2010-03-01)
const DELAY = +(process.env.BACKFILL_DELAY || 1200); // เว้นระหว่างคำขอ ไม่ยิงเว็บถี่เกินไป
const PROBE = process.argv.includes('--probe');
const KNOWN = [{"d":"20121101","f":"524694","l":"63"},{"d":"20130416","f":"843846","l":"86"},{"d":"20130502","f":"603458","l":"07"},{"d":"20140401","f":"028866","l":"95"},{"d":"20140416","f":"153406","l":"26"},{"d":"20140601","f":"781198","l":"18"},{"d":"20140901","f":"856763","l":"22"},{"d":"20141101","f":"206608","l":"44"},{"d":"20141216","f":"948354","l":"90"},{"d":"20150316","f":"048151","l":"92"},{"d":"20150416","f":"506260","l":"38"},{"d":"20151201","f":"915350","l":"78"},{"d":"20170616","f":"943142","l":"47"},{"d":"20170901","f":"143224","l":"65"},{"d":"20171016","f":"413494","l":"86"},{"d":"20180401","f":"412073","l":"85"},{"d":"20180416","f":"739229","l":"60"},{"d":"20181201","f":"021840","l":"67"},{"d":"20191101","f":"967375","l":"79"},{"d":"20200901","f":"999997","l":"98"},{"d":"20210916","f":"070935","l":"90"},{"d":"20220201","f":"944308","l":"30"},{"d":"20220217","f":"098597","l":"57"},{"d":"20220416","f":"395919","l":"58"},{"d":"20230816","f":"471782","l":"67"},{"d":"20231016","f":"931446","l":"44"},{"d":"20231230","f":"625544","l":"89"},{"d":"20240316","f":"997626","l":"78"},{"d":"20241101","f":"536044","l":"32"},{"d":"20241201","f":"669843","l":"61"},{"d":"20250102","f":"730209","l":"51"},{"d":"20250416","f":"266227","l":"85"},{"d":"20250516","f":"251309","l":"87"},{"d":"20250716","f":"245324","l":"26"},{"d":"20250801","f":"811852","l":"50"},{"d":"20250816","f":"994865","l":"63"},{"d":"20251016","f":"059696","l":"61"},{"d":"20251101","f":"345898","l":"87"},{"d":"20251116","f":"458145","l":"37"},{"d":"20260117","f":"878972","l":"02"}];
const TH = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
const pad = n => String(n).padStart(2, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = k => `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6)}`;
const key = s => s.replace(/-/g, '');

async function get(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (numora-backfill; personal non-commercial use)', 'accept-language': 'th' }, signal: AbortSignal.timeout(25000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) { if (i === tries) throw e; await sleep(2000 * i); }
  }
}

const strip = html => html
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ')
  .replace(/<br\s*\/?>|<\/(p|div|li|span|td|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t\r]+/g, ' ').replace(/\n\s*/g, '\n');

/* อ่านหนึ่งหน้า สำหรับงวดที่ขอ (want = 'YYYYMMDD') → { d, f, l, near } หรือ { err }
   หน้าเว็บมีเมนูรายการงวดล่าสุดที่ขึ้นต้นด้วย "งวดประจำวันที่" ด้วย จึงต้องหาหัวข้อที่ตรงกับวันที่ที่ขอเท่านั้น */
function parse(html, want) {
  const text = strip(html), flat = text.replace(/\s+/g, ' ');
  let h = null;
  for (const m of flat.matchAll(/งวดประจำวันที่\s*(\d{1,2})\s*([ก-๙]+)\s*(\d{4})/g)) {
    const mi = TH.indexOf(m[2]);
    if (mi >= 0 && `${+m[3] - 543}${pad(mi + 1)}${pad(+m[1])}` === want) {
      // เลือกตัวที่ตามด้วย "รางวัลที่ 1" ใกล้ที่สุด (เป็นหัวของผลรางวัล ไม่ใช่ลิงก์ในเมนู)
      const near1 = flat.slice(m.index, m.index + 300).search(/รางวัลที่\s*1(?!\d)/);
      if (near1 >= 0) { h = m; break; }
      if (!h) h = m;
    }
  }
  // สำรอง: หัวข้ออาจเขียนวันที่รูปแบบอื่น เช่น "16 ม.ค. 2543", "16 ม.ค. 43", "16/01/2543", "2000-01-16"
  let start = h ? h.index : -1;
  if (start < 0) {
    const y = +want.slice(0, 4), m = +want.slice(4, 6), dd = +want.slice(6), be = y + 543;
    const TS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
    const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pats = [`${dd}\\s*${esc(TS[m - 1])}\\s*(?:${be}|${String(be).slice(2)})(?!\\d)`, `${dd}\\s*${TH[m - 1]}\\s*${y}`,
      `0?${dd}/0?${m}/(?:${be}|${y}|${String(be).slice(2)})(?!\\d)`, `${y}-${pad(m)}-${pad(dd)}`];
    for (const ps of pats) {
      for (const mm of flat.matchAll(new RegExp(ps, 'g'))) {
        if (flat.slice(mm.index, mm.index + 300).search(/รางวัลที่\s*1(?!\d)/) >= 0) { start = mm.index; break; }
      }
      if (start >= 0) break;
    }
  }
  if (start < 0) return { err: 'ไม่มีงวดวันที่นี้ในหน้า', none: true };
  const d = want;
  const after = flat.slice(start);
  const seg = (start, ends) => {
    const i = after.search(start); if (i < 0) return '';
    const rest = after.slice(i).replace(start, '');
    let j = rest.length; for (const e of ends) { const k = rest.search(e); if (k > 0 && k < j) j = k; }
    return rest.slice(0, j).replace(/มี\s*\d+\s*รางวัล/g, ' ').replace(/\d{1,3}(,\d{3})+/g, ' ');
  };
  const NEXT = [/เลขหน้า\s*3\s*ตัว/, /เลขท้าย\s*3\s*ตัว/, /เลขท้าย\s*2\s*ตัว/, /ข้างเคียง/, /รางวัลที่\s*[2-5]/];
  const s1 = seg(/รางวัลที่\s*1(?!\d)/, NEXT);
  let f = (s1.match(/(?:^|\D)(\d{6})(?!\d)/) || [])[1];
  if (!f) { const m = s1.match(/(?:^|\D)(\d)\s+(\d)\s+(\d)\s+(\d)\s+(\d)\s+(\d)(?!\d)/); if (m) f = m.slice(1, 7).join(''); }
  const l = (seg(/เลขท้าย\s*2\s*ตัว/, [/ข้างเคียง/, /รางวัลที่/, /เลขหน้า/, /เลขท้าย\s*3/]).match(/(?:^|\D)(\d{2})(?!\d)/) || [])[1];
  const near = (seg(/ข้างเคียงรางวัลที่\s*1/, [/รางวัลที่\s*[2-5]/, /เลข/]).match(/\b\d{6}\b/g) || []).slice(0, 2);
  if (!f || !l) return { d, err: `อ่านเลขไม่ครบ (รางวัลที่ 1=${f || '-'} ท้าย 2 ตัว=${l || '-'})` };
  return { d, f, l, near };
}
const nearOk = r => {
  if (r.near.length < 2) return null;
  const n = +r.f, a = pad6((n + 999999) % 1000000), b = pad6((n + 1) % 1000000);
  return r.near.includes(a) && r.near.includes(b);
};
function pad6(n) { return String(n).padStart(6, '0'); }
const links = html => [...new Set((html.match(/date=(\d{4}-\d{2}-\d{2})/g) || []).map(s => s.slice(5)))];

async function loadHF() {
  try {
    const csv = await get(HF_CSV);
    if (!csv) return { map: null, note: 'ไม่พบไฟล์' };
    const lines = csv.trim().split(/\r?\n/), map = new Map();
    const head = lines[0].toLowerCase().split(',').map(x => x.trim().replace(/"/g, ''));
    const ci = n => head.indexOf(n);
    const EN = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const TS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
    const monthOf = v => {
      v = String(v).trim().replace(/"/g, '');
      if (/^\d+$/.test(v)) return +v;
      let i = TH.indexOf(v); if (i < 0) i = TS.indexOf(v); if (i < 0) i = EN.indexOf(v.slice(0, 3).toLowerCase());
      return i >= 0 ? i + 1 : null;
    };
    if (ci('date') >= 0 && ci('month') >= 0 && ci('year') >= 0) {
      const numCols = head.map((h, i) => (['date', 'month', 'year'].includes(h) ? -1 : i)).filter(i => i >= 0);
      for (const line of lines.slice(1)) {
        const c = line.split(',').map(x => x.trim().replace(/"/g, ''));
        const dd = +c[ci('date')], mo = monthOf(c[ci('month')]); let yy = +c[ci('year')];
        if (!dd || !mo || !yy) continue;
        if (yy > 2400) yy -= 543; else if (yy < 100) yy += yy > 50 ? 1900 : 2000;
        const nums = numCols.map(i => c[i]).filter(v => /^\d{1,2}$/.test(v)).map(v => v.padStart(2, '0'));
        if (nums.length) map.set(`${yy}${pad(mo)}${pad(dd)}`, new Set(nums));
      }
      return { map, note: `${map.size} แถว · หัวตาราง: ${lines[0].slice(0, 120)} · ตัวอย่าง: ${lines.slice(1, 4).join(' | ')}` };
    }
    for (const line of lines.slice(1)) {
      let k = null, m;
      if ((m = line.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) k = `${+m[1] > 2400 ? +m[1] - 543 : m[1]}${pad(m[2])}${pad(m[3])}`;
      else if ((m = line.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/))) k = `${+m[3] > 2400 ? +m[3] - 543 : m[3]}${pad(m[2])}${pad(m[1])}`;
      if (!k) continue;
      const rest = line.replace(m[0], ' ');
      const nums = (rest.match(/(?:^|[^\d])(\d{1,2})(?=[^\d]|$)/g) || []).map(x => x.replace(/\D/g, '').padStart(2, '0'));
      map.set(k, new Set(nums));
    }
    return { map, note: `${map.size} แถว · หัวตาราง: ${lines[0].slice(0, 120)}` };
  } catch (e) { return { map: null, note: 'โหลดไม่ได้: ' + e.message }; }
}

/* ---------------- probe ---------------- */
if (PROBE) {
  for (const day of ['2007-03-01', '2000-01-16', '1999-09-16']) {
    const html = await get(BASE + day + '+');
    console.log(`\n=== ${day} ===`);
    if (!html) { console.log('ไม่มีหน้า (404)'); continue; }
    const r = parse(html, key(day));
    console.log('ผลที่อ่านได้:', JSON.stringify(r), '| ข้างเคียงถูกต้อง:', r.f ? nearOk(r) : '-');
    const flat = strip(html).replace(/\s+/g, ' ');
    const [yy, mm, dd] = day.split('-').map(Number);
    let i = flat.indexOf(`งวดประจำวันที่ ${dd} ${TH[mm - 1]} ${yy + 543}`); if (i < 0) i = flat.indexOf('รางวัลที่ 1');
    console.log('ข้อความตัวอย่าง:', flat.slice(Math.max(0, i), i + 600));
    console.log('ลิงก์วันที่ในหน้า:', links(html).length, 'ลิงก์ เช่น', links(html).slice(0, 8).join(', '));
    await sleep(DELAY);
  }
  const hf = await loadHF(); console.log('\nHugging Face:', hf.note);
  process.exit(0);
}

/* ---------------- extra: เติมงวดท้ายปี ---------------- */
if (process.argv.includes('--extra')) {
  const file = JSON.parse(readFileSync('data/archive.json', 'utf8'));
  const have = new Set(file.draws.map(x => x.d));
  const hf = await loadHF();
  const added = [], skipped = [];
  for (let y = +START.slice(0, 4); y <= +END.slice(0, 4); y++) for (const dd of ['12-30', '12-31', '12-29']) {
    const day = `${y}-${dd}`;
    if (day < START || day > END || have.has(key(day))) continue;
    if ([...have].some(k => k.startsWith(`${y}12`) && +k.slice(6) >= 29)) continue; // ปีนี้มีงวดท้ายเดือนแล้ว
    let html; try { html = await get(BASE + day + '+'); } catch (e) { skipped.push(`${day}: โหลดไม่ได้ (${e.message})`); await sleep(DELAY); continue; }
    await sleep(DELAY);
    if (!html) continue;
    const r = parse(html, key(day));
    if (r.err) continue;
    const nk = nearOk(r), hset = hf.map && hf.map.get(r.d), hv = hset ? (hset.has(r.l) ? 'match' : 'mismatch') : 'na';
    if (nk === false || hv === 'mismatch') { skipped.push(`${day} ${r.f}/${r.l}: ไม่ผ่านการตรวจ (ข้างเคียง=${nk}, HF=${hv})`); continue; }
    have.add(r.d); added.push({ d: r.d, f: r.f, l: r.l, chk: `${nk ? 'near1' : ''}${hv === 'match' ? '+hf' : ''}` });
    console.log(`เพิ่ม ${day}: ${r.f} / ${r.l} (ตรวจ: ${added.at(-1).chk || 'none'})`);
  }
  file.draws = [...file.draws, ...added.map(({ d, f, l }) => ({ d, f, l }))].sort((a, b) => b.d.localeCompare(a.d));
  file.generatedAt = new Date().toISOString();
  writeFileSync('data/archive.json', JSON.stringify(file));
  const msg = `\nเติมงวดท้ายปี: เพิ่ม ${added.length} งวด · รวมทั้งหมด ${file.draws.length} งวด${skipped.length ? '\nข้าม:\n  ' + skipped.join('\n  ') : ''}`;
  console.log(msg);
  try { writeFileSync('scripts/backfill-report.txt', readFileSync('scripts/backfill-report.txt', 'utf8') + msg + '\n'); } catch {}
  process.exit(0);
}

/* ---------------- full run ---------------- */
const found = new Map(), fails = [], tried = new Set(), queue = [];
const inRange = s => s >= START && s <= END;
const enqueue = s => { if (inRange(s) && !tried.has(s)) { tried.add(s); queue.push(s); } };
// รอบแรก: วันที่ 1 และ 16 ของทุกเดือน
for (let y = +START.slice(0, 4); y <= +END.slice(0, 4); y++) for (let m = 1; m <= 12; m++) for (const dd of [1, 16]) enqueue(`${y}-${pad(m)}-${pad(dd)}`);

async function run(list, label) {
  let n = 0;
  for (const day of list) {
    n++; process.stdout.write(`\r${label} ${n}/${list.length} · พบแล้ว ${found.size} งวด   `);
    let html; try { html = await get(BASE + day + '+'); } catch (e) { fails.push(`${day}: โหลดไม่ได้ (${e.message})`); await sleep(DELAY); continue; }
    await sleep(DELAY);
    if (!html) continue;
    links(html).forEach(enqueue);
    const r = parse(html, key(day));
    if (r.err) { if (!r.none) fails.push(`${day}: ${r.err}`); continue; }
    if (!found.has(r.d)) found.set(r.d, r);
  }
  console.log();
}
await run(queue.splice(0), 'รอบที่ 1 (วันที่ 1/16)');
// รอบสอง: เดือนที่ยังขาดงวด ลองวันที่เลื่อนบ่อย + ลิงก์ที่เจอในหน้า
const monthsHave = m => [...found.keys()].filter(k => k.startsWith(m)).length;
for (let y = +START.slice(0, 4); y <= +END.slice(0, 4); y++) for (let m = 1; m <= 12; m++) {
  const ym = `${y}${pad(m)}`;
  if (monthsHave(ym) < 2) for (const dd of [2, 3, 4, 14, 15, 17, 18, 30, 31]) enqueue(`${y}-${pad(m)}-${pad(dd)}`);
}
await run(queue.splice(0), 'รอบที่ 2 (วันเลื่อน)');
if (queue.length) await run(queue.splice(0), 'รอบที่ 3 (ลิงก์เพิ่มเติม)');

// วัดความแม่นกับงวดที่รู้ผลแน่นอน
let accOk = 0, accBad = [], accMiss = 0;
for (const k of KNOWN) {
  try {
    const html = await get(BASE + iso(k.d) + '+'); await sleep(DELAY);
    const r = html ? parse(html, k.d) : null;
    if (!r || r.err) { accMiss++; continue; }
    if (r.f === k.f && r.l === k.l) accOk++; else accBad.push(`${k.d}: PPTV ${r.f}/${r.l} vs จริง ${k.f}/${k.l}`);
  } catch { accMiss++; }
  process.stdout.write(`\rตรวจความแม่น ${accOk + accBad.length + accMiss}/${KNOWN.length}   `);
}
console.log();

const hf = await loadHF();
const accepted = [], rejected = [];
for (const r of [...found.values()].sort((a, b) => b.d.localeCompare(a.d))) {
  const nk = nearOk(r);
  const hset = hf.map && hf.map.get(r.d);
  const hv = hset ? (hset.has(r.l) ? 'match' : 'mismatch') : 'na';
  const why = [];
  if (nk === false) why.push(`ข้างเคียง ${r.near.join(',')} ไม่ตรงกับรางวัลที่ 1 ±1`);
  if (hv === 'mismatch') why.push(`เลขท้าย 2 ตัว ${r.l} ไม่ตรงกับ Hugging Face (${[...hset].join(',')})`);
  if (why.length) rejected.push(`${r.d} ${r.f}/${r.l}: ${why.join(' · ')}`);
  else accepted.push({ d: r.d, f: r.f, l: r.l, chk: [nk ? 'near1' : null, hv === 'match' ? 'hf' : null].filter(Boolean).join('+') || 'none' });
}

mkdirSync('data', { recursive: true });
writeFileSync('data/archive.json', JSON.stringify({
  note: 'ผลสลากย้อนหลังก่อน 1 มี.ค. 2553 (d = วันที่ ค.ศ. YYYYMMDD, f = รางวัลที่ 1, l = เลขท้าย 2 ตัว)',
  source: 'PPTV HD36 (pptvhd36.com/lotto) · ตรวจเทียบ Hugging Face ANTDPU/ThaiGovernmentLotteryResults (MIT)',
  generatedAt: new Date().toISOString(), draws: accepted.map(({ d, f, l }) => ({ d, f, l })),
}));

const perYear = {}; accepted.forEach(a => { const y = +a.d.slice(0, 4) + 543; perYear[y] = (perYear[y] || 0) + 1; });
const unchecked = accepted.filter(a => a.chk === 'none');
const report = [
  `สรุปการดึงข้อมูลย้อนหลัง (${new Date().toLocaleString('th-TH')})`,
  `งวดที่เก็บได้: ${accepted.length} · ถูกตัดทิ้ง: ${rejected.length} · โหลด/อ่านไม่ได้: ${fails.length}`,
  `ช่วงข้อมูล: ${accepted.at(-1)?.d} – ${accepted[0]?.d}`,
  `ความแม่นของแหล่งข้อมูล (เทียบ ${KNOWN.length} งวดที่รู้ผล): ตรง ${accOk} · ไม่ตรง ${accBad.length} · หาไม่เจอ ${accMiss}`,
  ...accBad.map(x => '  ไม่ตรง: ' + x),
  `Hugging Face: ${hf.note}`,
  `ผ่านการตรวจ: ข้างเคียง+HF ${accepted.filter(a => a.chk === 'near1+hf').length} · ข้างเคียงอย่างเดียว ${accepted.filter(a => a.chk === 'near1').length} · HF อย่างเดียว ${accepted.filter(a => a.chk === 'hf').length} · ไม่มีตัวตรวจ ${unchecked.length}`,
  `จำนวนงวดต่อปี (ปกติ ~24): ${Object.entries(perYear).map(([y, n]) => `${y}:${n}`).join(' ')}`,
  rejected.length ? 'ถูกตัดทิ้ง:\n  ' + rejected.join('\n  ') : 'ไม่มีงวดถูกตัดทิ้ง',
  fails.length ? 'โหลด/อ่านไม่ได้:\n  ' + fails.slice(0, 40).join('\n  ') : '',
].join('\n');
writeFileSync('scripts/backfill-report.txt', report + '\n');
console.log('\n' + report);
