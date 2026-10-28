import { extractEntry } from '../lib/asar.js';

const asar = 'D:/Program Files (x86)/dsh/resources/app.asar';
const main = extractEntry(asar, 'lib/main.js').toString('utf8');
const acc = extractEntry(
  asar,
  'dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js',
).toString('utf8');
console.log('main zh restart label:', main.includes('restartApplication: "重启 DeepSeek Harness",'));
console.log('main en restart label:', main.includes('restartApplication: "Restart DeepSeek Harness",'));
console.log('main restart watchdog:', main.includes('dsh-retry.restart'));
console.log('main tray restart item:', main.includes('messages.restartApplication'));
console.log('account restart item:', acc.includes('dsh-retry-restart') && acc.includes('dshRetryRestart'));
console.log('account zh label:', acc.includes('重启 DeepSeek Harness'));
