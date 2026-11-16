// คัดลอกไฟล์แอปจากโฟลเดอร์ numora (โฟลเดอร์แม่) มาไว้ใน public/ แล้วอัปโหลดขึ้น Cloudflare
// ใช้: node deploy.mjs          (คัดลอก + deploy)
//      node deploy.mjs --copy   (คัดลอกอย่างเดียว)
// ไม่คัดลอกโฟลเดอร์ data/ — ข้อมูลผลรางวัลดึงต่อจากเว็บเดิมแบบสด
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const SRC = '..', OUT = 'public';
const FILES = ['index.html', 'app.js', 'vendor.js', 'styles.css', 'sw.js', 'manifest.json', 'icons'];
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT);
for (const f of FILES) {
  if (!existsSync(`${SRC}/${f}`)) { console.log('ไม่พบ', f, '(ข้าม)'); continue; }
  cpSync(`${SRC}/${f}`, `${OUT}/${f}`, { recursive: true });
}
// ใส่ noindex กันไม่ให้ Google เก็บหน้า
const ix = `${OUT}/index.html`, h = readFileSync(ix, 'utf8');
if (!h.includes('name="robots"')) writeFileSync(ix, h.replace('<head>', '<head>\n<meta name="robots" content="noindex,nofollow" />'));
console.log('คัดลอกไฟล์แอปไปที่ public/ แล้ว');
if (!process.argv.includes('--copy')) execSync('npx wrangler deploy', { stdio: 'inherit' });
