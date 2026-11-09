import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const config=JSON.parse(await readFile(path.join(root,'mobile/capacitor.config.json'),'utf8'));
if(config.server?.url)throw Error('Native app must not load a remote website');
if(config.appId!=='io.github.troglobiont.trailclients')throw Error('Wrong application ID');
if(config.plugins.CapacitorUpdater.autoUpdate!=='off'||config.plugins.CapacitorUpdater.statsUrl!=='')throw Error('Updates must be manual and analytics disabled');
const files=await readdir(path.join(root,'dist'));
for(const required of ['index.html','app.js','style.css','native.js','build-info.json'])if(!files.includes(required))throw Error('Missing '+required);
const manifest=await readFile(path.join(root,'mobile/android/app/src/main/AndroidManifest.xml'),'utf8');
if(!manifest.includes('android:allowBackup="false"'))throw Error('Cloud backups must not silently export client data');
for(const name of files){if(!['index.html','app.js','style.css','native.js','build-info.json','icon.svg'].includes(name))throw Error('Unexpected distributable file: '+name);if(!/\.(js|html|css|json)$/.test(name))continue;const contents=await readFile(path.join(root,'dist',name),'utf8');for(const forbidden of ['sk-proj-','ghp_','github_pat_'])if(contents.includes(forbidden))throw Error('Private data or credential in bundle: '+name);}
console.log('Native configuration and distributable content checks passed.');
