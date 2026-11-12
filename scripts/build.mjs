import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'dist');
// 公開物は明示した画面ファイルと画像だけ。設計資料・実測値・秘密設定は含めません。
const files=['index.html','app.js','styles.css','api.js','demo.js','config.js','manifest.webmanifest','sw.js'];
await fs.mkdir(output,{recursive:true});
for(const file of files)await fs.copyFile(path.join(root,file),path.join(output,file));
await fs.cp(path.join(root,'assets'),path.join(output,'assets'),{recursive:true});
await fs.writeFile(path.join(output,'.nojekyll'),'');
process.stdout.write('GitHub Pages用の公開ファイルをdist/に作成しました。\n');
