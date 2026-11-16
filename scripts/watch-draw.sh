#!/usr/bin/env bash
# เฝ้าผลหวยในวันที่อาจมีหวยออก: รอจนถึงช่วงประกาศผล แล้วเช็กทุก ~4 นาทีจนได้ผลครบทุกรางวัล
# เหตุผล: การตั้งเวลาของ GitHub (cron) มักช้าหลายชั่วโมงหรือข้ามรอบ จึงให้งานเริ่มตั้งแต่สายๆ แล้ว "นั่งรอ" เอง
# ปลอดภัย: ไม่ใช่วันที่ 1/2/16/17/30 → จบทันที · วันนั้นไม่มีหวยออก (ถึง 17:30 น. ยังไม่มีผล) → จบ · เลย 19:00 น. → จบ
set -u
TODAY=$(TZ=Asia/Bangkok date +%Y%m%d)
DOM=$(TZ=Asia/Bangkok date +%-d)
case " 1 2 16 17 30 " in *" $DOM "*) ;; *) echo "วันนี้ ($TODAY) ไม่ใช่วันที่อาจมีหวยออก — จบ"; exit 0;; esac

status() { # complete | partial | none
  node -e '
    const fs = require("fs"), k = process.argv[1];
    const rd = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
    const d = rd("data/draws.json"), p = rd("data/prizes.json");
    const has = (d.draws || []).some(x => x.d === k);
    const keys = ["first","near1","second","third","fourth","fifth","last3f","last3b","last2"];
    const full = p.draws && p.draws[k] && keys.every(x => Array.isArray(p.draws[k][x]) && p.draws[k][x].length);
    console.log(full && has ? "complete" : has ? "partial" : "none");
  ' "$TODAY"
}

commit_if_changed() {
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  if ! git diff --quiet -- data/draws.json data/prizes.json; then
    if git diff -U0 -- data/draws.json | grep -q '"d":' || ! git diff --quiet -- data/prizes.json; then
      git add data/draws.json data/prizes.json
      git commit -m "Add new draw results" && (git push || (git pull --rebase -X theirs && git push)) || echo "push skipped"
    else
      git checkout -- data/draws.json
    fi
  fi
  if [ -n "$(git status --porcelain -- data/tips.json)" ]; then
    git add data/tips.json && git commit -m "Update lucky numbers" && (git push || (git pull --rebase && git push)) || echo "tips push skipped"
  fi
}

echo "เฝ้าผลงวด $TODAY"
node scripts/update-tips.mjs || true
commit_if_changed
for i in $(seq 1 90); do
  git pull --rebase -q || true
  ST=$(status)
  HM=$((10#$(date -u +%H%M)))          # เวลา UTC (ไทย = +7)
  if [ "$ST" = complete ]; then echo "งวด $TODAY ได้ผลครบทุกรางวัลแล้ว — จบ"; commit_if_changed; exit 0; fi
  if [ "$HM" -ge 1200 ]; then echo "เลย 19:00 น. แล้ว — จบ (สถานะ: $ST)"; exit 0; fi
  if [ "$ST" = none ] && [ "$HM" -ge 1030 ]; then echo "17:30 น. แล้วยังไม่มีผลงวด $TODAY — วันนี้น่าจะไม่มีหวยออก จบ"; exit 0; fi
  if [ "$HM" -lt 750 ]; then echo "$(TZ=Asia/Bangkok date +%H:%M) ยังไม่ถึงเวลาประกาศผล รอ 5 นาที"; sleep 300; continue; fi
  echo "$(TZ=Asia/Bangkok date +%H:%M) เช็กผล (สถานะก่อนเช็ก: $ST)"
  node scripts/update-draws.mjs || true
  commit_if_changed
  sleep 240
done
echo "ครบจำนวนรอบ — จบ"
