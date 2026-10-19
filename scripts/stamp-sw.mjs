// 部署前（.github/workflows/pages.yml）：檢查 sw.js 離線快取清單（SHELL）的檔案都在網站目錄裡，
// 並把 APP_CACHE 換成全部 App 檔案內容的雜湊 —— 任何檔案改了 Service Worker 就會更新，整批換成新版（不會新舊混用）。
// 清單少了任何一個檔案，Service Worker 就裝不起來（以前漏了 copy-worker.js），所以缺檔時部署直接失敗。
//   node scripts/stamp-sw.mjs <網站目錄>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const dir = process.argv[2] || '.';
const file = join(dir, 'sw.js'), src = readFileSync(file, 'utf8');
const shell = JSON.parse(src.match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"'));
const miss = shell.filter((f) => f !== './' && !existsSync(join(dir, f)));
if (miss.length) {
  console.error('離線快取清單的檔案不存在：' + miss.join(', '));
  process.exit(1);
}
const h = createHash('sha256');
for (const f of shell) if (f !== './') h.update(f).update(readFileSync(join(dir, f)));
const tag = 'watertool-app-' + h.digest('hex').slice(0, 12);
writeFileSync(file, src.replace(/const APP_CACHE = '[^']*'/, `const APP_CACHE = '${tag}'`));
console.log(tag);
