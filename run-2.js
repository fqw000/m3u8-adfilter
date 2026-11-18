'use strict';

/**
 * 离线回归：跑 fixtures 目录下所有样本，比对期望结果
 *   node test/run.js [-v]
 */

const fs = require('fs');
const path = require('path');
const { filterPlaylist } = require('./lib/filter-playlist');

const DIR = path.resolve(__dirname, '.', 'fixtures');
const verbose = process.argv.includes('-v');
const expects = JSON.parse(fs.readFileSync(path.join(DIR, 'expect.json'), 'utf8'));

const results = [];
let pass = 0;
let fail = 0;

for (const e of expects) {
  const file = path.join(DIR, e.file);
  const text = fs.readFileSync(file, 'utf8');
  const res = filterPlaylist(text, e.file, { verbose });
  const removed = (res.report.summary || {}).removedCount || 0;
  const ok = res.report.verdict === e.verdict && (e.removed === undefined || removed === e.removed);

  if (ok) pass++; else fail++;

  const rebuilt = res.changed ? res.body : null;
  results.push({
    ok,
    file: e.file,
    desc: e.desc,
    verdict: res.report.verdict,
    expect: e.verdict,
    removed: removed + '/' + (res.report.parse.segments || 0) + ' 段',
    verify: (res.report.verify && res.report.verify.issues) ? (res.report.verify.ok ? 'ok' : 'FAIL ' + res.report.verify.issues.join('|')) : '-',
    rebuilt,
  });

  if (!ok && verbose) {
    console.log('\n--- 未通过: ' + e.file + ' (期望 ' + e.verdict + '/' + e.removed + ', 实际 ' + res.report.verdict + '/' + removed + ')');
    console.log(res.report.lines.join('\n'));
  }
}

function pad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s.slice(0, n);
}

console.log('\n离线回归结果  (fixtures/)');
console.log('-'.repeat(96));
console.log(pad('', 4) + pad('样本', 30) + pad('形态', 32) + pad('判定', 10) + pad('删除', 12) + '自校验');
console.log('-'.repeat(96));
for (const r of results) {
  console.log(
    pad(r.ok ? ' OK ' : ' NG ', 4) +
    pad(r.file, 30) +
    pad(r.desc, 32) +
    pad(r.verdict + (r.verdict === r.expect ? '' : '(' + r.expect + ')'), 10) +
    pad(r.removed, 12) +
    r.verify
  );
}
console.log('-'.repeat(96));
console.log('通过 ' + pass + ' / ' + (pass + fail) + (fail ? '，失败 ' + fail : ''));

/* 把每个样本的处理后结果落盘，便于肉眼比对 */
const OUT = path.resolve(__dirname, '..', 'out', 'fixtures');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
for (const r of results) {
  if (!r.rebuilt) continue;
  fs.writeFileSync(path.join(OUT, r.file.replace('.m3u8', '.filtered.m3u8')), r.rebuilt + '\n');
}

process.exit(fail ? 1 : 0);

