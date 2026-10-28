import { extractEntry } from '../lib/asar.js';

const asar = 'D:/Program Files (x86)/dsh/resources/app.asar';
const acc = extractEntry(
  asar,
  'dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js',
).toString('utf8');

const anchors = ['\t\t\tsettings: "Settings",', '\t\t\tsettings: "设置",', '\t\t\tsettings: '];
for (const a of anchors) {
  let count = 0;
  let i = 0;
  while ((i = acc.indexOf(a, i)) !== -1) { count++; i += a.length; }
  console.log(JSON.stringify(a), 'count=', count);
}

const i = acc.indexOf('\t\t\tsettings: "设置",');
if (i !== -1) console.log('ZH context:', JSON.stringify(acc.slice(i - 200, i + 200)));
const j = acc.indexOf('\t\t\tsettings: "Settings",');
if (j !== -1) console.log('EN context:', JSON.stringify(acc.slice(j - 200, j + 200)));
