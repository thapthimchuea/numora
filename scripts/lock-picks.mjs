// ล็อกชุดลุ้นของงวดถัดไป (หวยรัฐบาลไทย) ลง data/picks.json ก่อนเวลาออกรางวัล
// - set  = เลข 2 ตัว 20 ตัว (ใช้กับ 2 ตัวล่าง / 2 ตัวบน / บนหรือล่าง) 10 ตัวแรกคือชุด 10
// - set3 = เลข 3 ตัว 20 ตัว (ใช้กับ 3 ตัวบน = 3 ตัวท้ายของรางวัลที่ 1)
// - ใช้สูตรผสมผสานตัวเดียวกับในแอป (ดึงโค้ดคำนวณจาก app.js โดยตรง จึงได้เลขเหมือนในแอปเสมอ)
// - ใช้เฉพาะผลที่ออกแล้ว ณ ตอนล็อก · ล็อกแล้วไม่เขียนทับ · เลยเวลาออกแล้วจะไม่ล็อกย้อนหลัง
// ใช้:  node scripts/lock-picks.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const APP = new URL('app.js', ROOT), DRAWS = new URL('data/draws.json', ROOT), PICKS = new URL('data/picks.json', ROOT);
const LOCK_MARGIN_MIN = 5; // ต้องล็อกก่อนเวลาเริ่มออกรางวัลอย่างน้อย 5 นาที

function loadCore() {
  const src = readFileSync(APP, 'utf8');
  const cut = src.indexOf('const APP_CREDIT');
  if (cut < 0) throw new Error('ไม่พบจุดตัดใน app.js');
  const React = { useState() {}, useMemo() {}, useEffect() {}, useRef() {}, createElement() {}, createContext: v => ({ v }), useContext() {} };
  // formulaName ใช้แค่ทำข้อความอธิบาย (อยู่หลังจุดตัด) → ใส่ตัวแทนไว้
  const code = 'const formulaName = x => x;\n' + src.slice(0, cut) + '\nreturn { BASE_DRAWS, FORMULAS, F3, predict, predict3, makeDraw, keyOf, getNextDrawDate, DRAW_HOUR, DRAW_MIN };';
  return new Function('React', 'localStorage', 'window', 'navigator', 'document', code)(React, { getItem: () => null, setItem() {} }, {}, {}, {});
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const kd = k => new Date(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8));

const C = loadCore();
const db = JSON.parse(readFileSync(DRAWS, 'utf8'));
const have = new Set(C.BASE_DRAWS.map(d => d.id));
const online = (db.draws || []).filter(r => /^\d{8}$/.test(r.d) && /^\d{6}$/.test(r.f) && /^\d{2}$/.test(r.l) && !have.has(r.d))
  .map(r => C.makeDraw(kd(r.d), r.f, r.l, 'online'));
const draws = [...online, ...C.BASE_DRAWS].sort((a, b) => b.date - a.date);
const latest = draws[0].id;
const target = C.keyOf(C.getNextDrawDate(draws[0].date));
// เวลาเริ่มออกรางวัล (เวลาไทย) ของงวดเป้าหมาย แปลงเป็นเวลา UTC
const drawMs = Date.UTC(+target.slice(0, 4), +target.slice(4, 6) - 1, +target.slice(6, 8), C.DRAW_HOUR - 7, C.DRAW_MIN);
const nowMs = Date.now();

const pk = existsSync(PICKS) ? JSON.parse(readFileSync(PICKS, 'utf8')) : {};
pk.note = 'ชุดลุ้นที่ล็อกไว้ก่อนผลออก (d = งวดวันที่ ค.ศ., set = เลข 2 ตัว 20 ตัว, set3 = เลข 3 ตัว 20 ตัว · เรียงตามคะแนน 10 ตัวแรกคือชุด 10, at = เวลาที่ล็อก, base = งวดล่าสุดที่ใช้คำนวณ) · ล็อกแล้วไม่แก้ไข';
pk.since = pk.since || target;
pk.picks = Array.isArray(pk.picks) ? pk.picks : [];

if (pk.picks.some(p => p.d === target)) {
  console.log(`งวด ${target} ล็อกไว้แล้ว — ไม่เปลี่ยน`);
} else if (nowMs > drawMs - LOCK_MARGIN_MIN * 60e3) {
  console.log(`งวด ${target} เลยเวลาล็อกแล้ว (ต้องก่อน ${pad(C.DRAW_HOUR)}:${pad(C.DRAW_MIN)} น.) — ไม่ล็อกย้อนหลัง`);
} else {
  const date = kd(target);
  const set = C.predict('ensemble', draws, date, 20).pairs.map(p => pad(p.n));
  const set3 = C.predict3('ensemble', draws, date, 20, 'top3', null).pairs.map(p => pad(p.n, 3));
  if (set.length !== 20 || new Set(set).size !== 20) throw new Error('ชุดเลข 2 ตัวไม่ครบ 20 ตัว');
  if (set3.length !== 20 || new Set(set3).size !== 20) throw new Error('ชุดเลข 3 ตัวไม่ครบ 20 ตัว');
  pk.picks.push({ d: target, set, set3, at: new Date(nowMs).toISOString(), base: latest });
  pk.picks.sort((a, b) => a.d.localeCompare(b.d));
  writeFileSync(PICKS, JSON.stringify(pk, null, 1) + '\n');
  console.log(`ล็อกงวด ${target}: 2 ตัว ชุด 10 = ${set.slice(0, 10).join(' ')} · +10 = ${set.slice(10).join(' ')} | 3 ตัว ชุด 10 = ${set3.slice(0, 10).join(' ')} · +10 = ${set3.slice(10).join(' ')} (ใช้ผลถึง ${latest})`);
}

// ===== สถิติสูตร: ล็อกเลข 10 ตัวแรกของทุกสูตร (2 ตัว และ 3 ตัวบน) ลง data/formulas.json =====
{
  const FILE = new URL('data/formulas.json', ROOT);
  const N = 10;
  const fx = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
  fx.note = 'เลข 10 ตัวแรกของทุกสูตรที่ล็อกไว้ก่อนผลออก (d = งวดวันที่ ค.ศ., f2 = เลข 2 ตัวต่อกัน, f3 = เลข 3 ตัวบนต่อกัน, at = เวลาที่ล็อก, base = งวดล่าสุดที่ใช้คำนวณ) · ล็อกแล้วไม่แก้ไข';
  fx.since = fx.since || target;
  fx.n = N;
  fx.picks = Array.isArray(fx.picks) ? fx.picks : [];
  const late = nowMs > drawMs - LOCK_MARGIN_MIN * 60e3;
  if (fx.picks.some(p => p.d === target)) console.log(`สถิติสูตร: งวด ${target} ล็อกไว้แล้ว`);
  else if (late) console.log(`สถิติสูตร: งวด ${target} เลยเวลาล็อกแล้ว`);
  else {
    const date = kd(target);
    const f2 = {}, f3 = {};
    for (const f of C.FORMULAS) {
      if (f.id === 'tips' || f.id === 'overlap' || typeof f.score !== 'function') continue;
      const nums = C.predict(f.id, draws, date, N).pairs.map(p => pad(p.n));
      if (nums.length === N) f2[f.id] = nums.join('');
    }
    for (const k of Object.keys(C.F3)) {
      const nums = C.predict3(k, draws, date, N, 'top3', null).pairs.map(p => pad(p.n, 3));
      if (nums.length === N) f3[k] = nums.join('');
    }
    fx.picks.push({ d: target, f2, f3, at: new Date(nowMs).toISOString(), base: latest });
    fx.picks.sort((a, b) => a.d.localeCompare(b.d));
    writeFileSync(FILE, JSON.stringify(fx) + '\n');
    console.log(`สถิติสูตร: ล็อกงวด ${target} · 2 ตัว ${Object.keys(f2).length} สูตร · 3 ตัว ${Object.keys(f3).length} สูตร`);
  }
}
