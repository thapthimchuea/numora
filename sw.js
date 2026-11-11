/* Numora service worker
   เมื่ออัปโหลดไฟล์เวอร์ชันใหม่ ให้เปลี่ยนเลข VERSION ด้านล่าง (เช่น v1 -> v2) เพื่อให้มือถือทุกเครื่องได้ไฟล์ใหม่ */
const VERSION = 'v3';
const CACHE = 'numora-' + VERSION;
const APP_SHELL = [
  './', './index.html', './app.js', './vendor.js', './styles.css', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png',
];
const CDN_SHELL = [ // โหลดล่วงหน้าแบบ best-effort (ถ้าโหลดไม่ได้ก็ไม่ทำให้ติดตั้งล้มเหลว)
  'https://unpkg.com/lucide-react@0.263.1/dist/umd/lucide-react.js',
  'https://fonts.googleapis.com/css2?family=Kanit:wght@300;400;500;600;700&family=Orbitron:wght@500;700;900&display=swap',
];
const NEVER_CACHE = ['lotto.api.rayriffy.com']; // ผลรางวัลออนไลน์: ดึงสดเสมอ (แอปจัดการกรณีออฟไลน์เอง)

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(APP_SHELL.map(u => new Request(u, { cache: 'reload' }))); // ข้ามแคชเบราว์เซอร์ ได้ไฟล์ล่าสุดเสมอ
    await Promise.all(CDN_SHELL.map(u => fetch(u, { mode: 'cors' }).then(r => r.ok && c.put(u, r)).catch(() => {})));
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => (k.startsWith('numora-') || k.startsWith('lottostat-')) && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (NEVER_CACHE.some(h => url.hostname.includes(h))) return;

  // หน้าแอป: ลองเน็ตก่อน (ได้เวอร์ชันล่าสุด) ถ้าออฟไลน์ใช้ของในเครื่อง
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return res; })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // ไฟล์อื่นๆ (สคริปต์ ฟอนต์ ไอคอน): ใช้ของในเครื่องทันที แล้วอัปเดตเบื้องหลัง
  e.respondWith(
    caches.open(CACHE).then(cache => cache.match(req).then(cached => {
      const network = fetch(url.origin === location.origin ? new Request(req, { cache: 'no-cache' }) : req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    }))
  );
});
