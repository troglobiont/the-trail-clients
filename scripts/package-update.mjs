import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
const info=JSON.parse(await readFile(path.join(root,'dist/build-info.json'),'utf8'));
if(info.version!==version)throw Error('Run build before packaging updates');
const out=path.join(root,'mobile/update');await mkdir(out,{recursive:true});
const zip=path.join(out,'THE-TRAIL-Clients-update.zip');
execFileSync('python3',['-c',`from pathlib import Path
import zipfile,sys
source=Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2],'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as out:
 for file in sorted(source.rglob('*')):
  if not file.is_file():continue
  info=zipfile.ZipInfo(file.relative_to(source).as_posix(),date_time=(2020,1,1,0,0,0))
  info.compress_type=zipfile.ZIP_DEFLATED;info.create_system=3;info.external_attr=0o100644<<16
  out.writestr(info,file.read_bytes(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
`,path.join(root,'dist'),zip]);
const bytes=await readFile(zip),sha256=createHash('sha256').update(bytes).digest('hex');
const manifest={schemaVersion:1,appId:'io.github.troglobiont.trailclients',version,nativeRuntime:1,minNativeVersion:'0.1.10',bundle:{url:`https://github.com/troglobiont/the-trail-clients/releases/download/v${version}/THE-TRAIL-Clients-update.zip`,sha256}};
await writeFile(path.join(out,'version.json'),JSON.stringify(manifest,null,2)+'\n');
await writeFile(path.join(out,'SHA256SUMS'),sha256+'  THE-TRAIL-Clients-update.zip\n');
console.log(JSON.stringify({version,bytes:bytes.length,sha256}));
