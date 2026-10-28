import fs from 'node:fs';
const file = process.argv[2];
const needle = process.argv[3];
const before = Number(process.argv[4] ?? 300);
const after = Number(process.argv[5] ?? 600);
const s = fs.readFileSync(file, 'utf8');
let from = 0, n = 0;
while (true) {
  const i = s.indexOf(needle, from);
  if (i < 0) break;
  n++;
  console.log(`--- hit ${n} at ${i} ---`);
  console.log(JSON.stringify(s.slice(Math.max(0, i - before), i + after)));
  from = i + needle.length;
  if (n >= 5) break;
}
if (n === 0) console.log('NO HIT', JSON.stringify(needle));
