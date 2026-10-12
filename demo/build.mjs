// 產生 GitHub Pages 示範版到 _site/：node demo/build.mjs
// 正式版的網址都從網站根目錄開始（/style.css、/s/…），GitHub Pages 則放在 /<repo>/ 底下，
// 所以這裡把路徑改成相對路徑，並在每頁最前面載入 demo/shim.js。
// 每一處替換都檢查有沒有改到；正式版程式改了導致對不上時，建置會直接失敗提醒。
import { cpSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '_site');
rmSync(out, { recursive: true, force: true });
cpSync(join(root, 'public'), out, { recursive: true });
rmSync(join(out, '_headers'), { force: true });
mkdirSync(join(out, 'demo'));
writeFileSync(join(out, '.nojekyll'), '');

function edit(file, pairs) {
  let s = readFileSync(file, 'utf8');
  for (const [from, to] of pairs) {
    const n = typeof from === 'string' ? s.split(from).length - 1 : (s.match(from) || []).length;
    if (!n) throw new Error(`${relative(root, file)}：找不到要替換的「${from}」`);
    s = typeof from === 'string' ? s.split(from).join(to) : s.replace(from, to);
  }
  writeFileSync(file, s);
}

// Worker 與資料表結構：在瀏覽器裡執行，Response 換成可以帶 set-cookie 的模擬版
cpSync(join(root, 'src', 'schema.js'), join(out, 'demo', 'schema.js'));
cpSync(join(root, 'src', 'worker.js'), join(out, 'demo', 'worker.js'));
edit(join(out, 'demo', 'worker.js'), [['new Response(', 'new globalThis.__DemoResponse(']]);
cpSync(join(root, 'demo', 'shim.js'), join(out, 'demo', 'shim.js'));
for (const f of ['sql-wasm.js', 'sql-wasm.wasm']) cpSync(join(root, 'node_modules', 'sql.js', 'dist', f), join(out, 'demo', f));

// HTML：絕對路徑改相對路徑，最前面插入 shim
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
for (const file of walk(out).filter((f) => f.endsWith('.html'))) {
  const depth = relative(out, file).split(sep).length - 1;
  const rel = depth ? '../'.repeat(depth) : './';
  edit(file, [
    [/(href|src)="\/(?!\/)/g, `$1="${rel}`],
    ['<meta charset="utf-8">', `<meta charset="utf-8">\n<script src="${rel}demo/shim.js"></script>`],
  ]);
  if (!depth) edit(file, [['url=/admin/', 'url=./admin/']]);
}

// 程式裡組出來的網址
edit(join(out, 'admin', 'app.js'), [
  ["loadScript('/vendor/", "loadScript(DEMO_BASE + 'vendor/"],
  ['${location.origin}/', '${location.origin}${DEMO_BASE}'],
  ['${h(location.host)}/me', '${h(location.host + DEMO_BASE)}me'],
]);
edit(join(out, 's', 'app.js'), [["history.replaceState(null, '', '/s/')", "history.replaceState(null, '', location.pathname)"]]);

console.log('示範版已輸出到 _site/');
