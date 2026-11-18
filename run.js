'use strict';

/**
 * 本地跑测 CLI
 *
 *   node bin/run.js --url  https://example.com/x.m3u8 [--dry-run] [--verbose] [--json]
 *   node bin/run.js --file fixtures/01-scte-cueout.m3u8
 *   node bin/run.js --dir  fixtures
 *   node bin/run.js --list urls.txt
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { filterPlaylist } = require('./lib/filter-playlist');

const OUT_DIR = path.resolve(__dirname, '.', 'out');

/* ---------------- 抓取 ---------------- */

function fetchText(url, hop = 0) {
  return new Promise((resolve, reject) => {
    if (hop > 5) return reject(new Error('too many redirects'));
    const mod = url.indexOf('https:') === 0 ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      timeout: 20000,
    }, (res) => {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchText(next, hop + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/* ---------------- 参数 ---------------- */

function parseArgs(argv) {
  const out = { urls: [], files: [], dir: null, dryRun: false, verbose: false, json: false, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.urls.push(argv[++i]);
    else if (a === '--file') out.files.push(argv[++i]);
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--list') {
      const list = fs.readFileSync(argv[++i], 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
      out.urls.push(...list);
    } else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--json') out.json = true;
    else if (a === '--quiet') out.quiet = true;
  }
  return out;
}

function slug(input) {
  return String(input)
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 90) || 'local';
}

function ensureOut() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}

/* ---------------- 单条处理 ---------------- */

async function runOne(source, text, opts) {
  const cfg = { dryRun: opts.dryRun, verbose: opts.verbose, logSegments: opts.verbose };
  const t0 = Date.now();
  let res;
  try {
    res = filterPlaylist(text, source, cfg);
  } catch (e) {
    return { source, error: e.message, verdict: 'ERROR' };
  }
  const ms = Date.now() - t0;

  if (!opts.quiet) {
    console.log('\n' + '='.repeat(78));
    console.log('SOURCE: ' + source);
    console.log('='.repeat(78));
    console.log(res.report.lines.join('\n'));
  }

  ensureOut();
  const name = slug(source);
  fs.writeFileSync(path.join(OUT_DIR, name + '.report.txt'), res.report.lines.join('\n') + '\n');
  if (res.changed) fs.writeFileSync(path.join(OUT_DIR, name + '.filtered.m3u8'), res.body + '\n');

  const s = res.report.summary || {};
  return {
    source,
    verdict: res.report.verdict,
    gate: res.report.gate,
    segments: res.report.parse.segments,
    removed: s.removedCount || 0,
    removedDur: s.removedDur || 0,
    totalDur: s.totalDur || 0,
    reasons: Object.keys(s.reasons || {}),
    ms,
    changed: res.changed,
    report: res.report,
  };
}

/* ---------------- 入口 ---------------- */

(async function main() {
  const opts = parseArgs(process.argv);
  const results = [];

  const jobs = [];
  for (const f of opts.files) jobs.push({ source: f, read: () => fs.readFileSync(f, 'utf8') });
  if (opts.dir) {
    for (const f of fs.readdirSync(opts.dir).sort()) {
      if (!f.endsWith('.m3u8')) continue;
      const p = path.join(opts.dir, f);
      jobs.push({ source: p, read: () => fs.readFileSync(p, 'utf8') });
    }
  }
  for (const u of opts.urls) jobs.push({ source: u, read: () => fetchText(u) });

  if (!jobs.length) {
    console.log('用法: node bin/run.js --url <m3u8> | --file <path> | --dir <dir> | --list <file>');
    process.exit(1);
  }

  for (const job of jobs) {
    let text;
    try {
      text = await job.read();
    } catch (e) {
      results.push({ source: job.source, error: e.message, verdict: 'FETCH_FAIL' });
      if (!opts.quiet) console.log('\n!! ' + job.source + ' 抓取失败: ' + e.message);
      continue;
    }
    results.push(await runOne(job.source, text, opts));
  }

  /* 汇总表 */
  console.log('\n' + '-'.repeat(78));
  console.log('SUMMARY');
  console.log('-'.repeat(78));
  const rows = results.map((r) => ({
    verdict: r.verdict,
    removed: r.error ? '-' : r.removed + '/' + r.segments,
    dur: r.error ? '-' : (r.removedDur || 0) + '/' + (r.totalDur || 0) + 's',
    // source: r.source.length > 46 ? '…' + r.source.slice(-45) : r.source,
    source: r.source,
    note: r.error || (r.gate || ''),
  }));
  const w = [10, 9, 14, 48, 30];
  const line = (a) => a.map((s, i) => pad(String(s), w[i])).join(' ');
  console.log(line(['VERDICT', 'REMOVED', 'DURATION', 'SOURCE', 'NOTE']));
  for (const r of rows) console.log(line([r.verdict, r.removed, r.dur, r.source, r.note]));

  if (opts.json) {
    fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(results.map(({ report, ...r }) => r), null, 2));
    console.log('\nsummary.json 已写入 out/');
  }
})();

function pad(s, n) {
  s = String(s);
  let out = s;
  while (out.length < n) out += ' ';
  return out.slice(0, n);
}
