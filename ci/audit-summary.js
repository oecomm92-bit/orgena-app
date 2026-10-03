#!/usr/bin/env node
/*
 * CI helper for .github/workflows/audit.yml (no dependencies).
 *
 *   node ci/audit-summary.js job  <audit-results.json> "<label>"
 *       Appends a totals table (+ any BROKEN findings) for one audit run to the job summary.
 *
 *   node ci/audit-summary.js diff <dir>
 *       Reads every <dir>/<artifact>/audit-results.json, and writes a table of every check whose
 *       outcome differs between chromium vs webkit (same target) or local vs live (same engine).
 *       Also writes <dir>/audit-diff.md and <dir>/audit-diff.json.
 *
 * Output goes to $GITHUB_STEP_SUMMARY when set, otherwise to stdout.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const BUCKETS = ['BROKEN', 'INCONSISTENT', 'SUSPECT', 'NOT_VERIFIED', 'ACCEPTED', 'passed'];
const HEAD = ['BROKEN', 'INCONSISTENT', 'SUSPECT', 'NOT VERIFIED', 'ACCEPTED', 'passed'];
const RUN_ORDER = ['local-chromium', 'local-webkit', 'live-chromium', 'live-webkit'];

function emit(md) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  else process.stdout.write(md + '\n');
}
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }

function jobSummary(file, label) {
  const r = readJson(file);
  let md = `### Orgena audit — ${label}\n\n`;
  if (!r) {
    md += `**No results** — \`${file}\` was not written (the audit harness crashed before finishing; see the log).\n`;
    emit(md); return;
  }
  const t = r.totals || {};
  md += `Target: \`${r.url}\` · engine **${r.engine}** · commit \`${(r.commit || '').slice(0, 7)}\`` +
    (r.engine === 'webkit' ? ' · _WebKit is an iOS-Safari proxy, not a real device_' : '') + '\n\n';
  md += `| ${HEAD.join(' | ')} |\n|${HEAD.map(() => '---:').join('|')}|\n| ${BUCKETS.map(b => t[b] ?? 0).join(' | ')} |\n\n`;
  md += (t.BROKEN ? '❌ **Job fails: BROKEN findings present.**' : '✅ No BROKEN findings (job passes; other buckets are warnings).') + '\n';
  const broken = (r.buckets && r.buckets.BROKEN) || [];
  if (broken.length) md += '\n<details open><summary>BROKEN</summary>\n\n' + broken.map(x => `- ${esc(x)}`).join('\n') + '\n\n</details>\n';
  const inc = (r.buckets && r.buckets.INCONSISTENT) || [];
  if (inc.length) md += '\n<details><summary>INCONSISTENT</summary>\n\n' + inc.map(x => `- ${esc(x)}`).join('\n') + '\n\n</details>\n';
  emit(md);
}

function diffSummary(dir) {
  const runs = {};
  const found = [];
  if (fs.existsSync(dir)) {
    for (const sub of fs.readdirSync(dir)) {
      const f = path.join(dir, sub, 'audit-results.json');
      const r = readJson(f);
      if (!r) continue;
      const key = `${r.target}-${r.engine}`;
      runs[key] = r; found.push(`${key} ← ${sub}`);
    }
  }
  const keys = RUN_ORDER.filter(k => runs[k]);
  let md = '## Cross-engine / cross-URL comparison\n\n';
  if (!keys.length) { md += 'No audit results were available to compare.\n'; emit(md); return writeOut(dir, md, { runs: [], diffs: [] }); }

  // Totals per run.
  md += `| run | loaded | ${HEAD.join(' | ')} |\n|---|---|${HEAD.map(() => '---:').join('|')}|\n`;
  for (const k of RUN_ORDER) {
    const r = runs[k];
    md += r ? `| ${k} | ${r.loaded ? 'yes' : '**no**'} | ${BUCKETS.map(b => (r.totals || {})[b] ?? 0).join(' | ')} |\n`
      : `| ${k} | _not run_ | ${HEAD.map(() => '—').join(' | ')} |\n`;
  }
  md += '\n';

  // Only runs that actually loaded the app take part in the per-check comparison.
  const usable = keys.filter(k => runs[k].loaded);
  const outcome = {}; const msg = {};
  for (const k of usable) for (const f of (runs[k].findings || [])) {
    (outcome[f.id] = outcome[f.id] || {})[k] = f.bucket;
    // Show the message from the most severe outcome (the failing text, not the passing one).
    if (!msg[f.id] || BUCKETS.indexOf(f.bucket) < BUCKETS.indexOf(msg[f.id].bucket)) msg[f.id] = { bucket: f.bucket, text: f.msg };
  }
  const pairs = [
    ['local-chromium', 'local-webkit', 'chromium vs webkit (local)'],
    ['live-chromium', 'live-webkit', 'chromium vs webkit (live)'],
    ['local-chromium', 'live-chromium', 'local vs live (chromium)'],
    ['local-webkit', 'live-webkit', 'local vs live (webkit)'],
  ];
  const pairStats = pairs.map(([a, b, label]) => {
    if (!usable.includes(a) || !usable.includes(b)) return { label, compared: false, diffs: 0 };
    let n = 0; for (const id of Object.keys(outcome)) if ((outcome[id][a] || '—') !== (outcome[id][b] || '—')) n++;
    return { label, compared: true, diffs: n };
  });
  md += '| comparison | checks with a different outcome |\n|---|---:|\n';
  for (const p of pairStats) md += `| ${p.label} | ${p.compared ? p.diffs : '_not compared (one side missing or did not load)_'} |\n`;
  md += '\n';

  const diffs = [];
  for (const id of Object.keys(outcome).sort()) {
    const o = outcome[id];
    const differs = pairs.some(([a, b]) => usable.includes(a) && usable.includes(b) && (o[a] || '—') !== (o[b] || '—'));
    if (differs) diffs.push({ id, msg: msg[id].text, outcomes: Object.fromEntries(usable.map(k => [k, o[k] || '—'])) });
  }
  if (!diffs.length) md += '✅ No check differs between the compared runs.\n';
  else {
    md += `### ${diffs.length} check(s) with differing outcomes\n\n_“—” = the check did not report in that run (e.g. a live-only font check, or a branch not reached)._\n\n`;
    md += `| check | ${usable.join(' | ')} | message (most severe outcome) |\n|---|${usable.map(() => '---').join('|')}|---|\n`;
    for (const d of diffs) md += `| \`${esc(d.id)}\` | ${usable.map(k => d.outcomes[k]).join(' | ')} | ${esc(clip(d.msg || '', 160))} |\n`;
  }
  const notLoaded = keys.filter(k => !runs[k].loaded);
  if (notLoaded.length) md += `\n⚠️ Did not load (excluded from the per-check comparison): ${notLoaded.join(', ')}\n`;
  md += `\n<sub>Artifacts read: ${found.join('; ')}</sub>\n`;
  emit(md);
  writeOut(dir, md, { runs: keys, pairStats, diffs });
}
function writeOut(dir, md, json) {
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'audit-diff.md'), md); fs.writeFileSync(path.join(dir, 'audit-diff.json'), JSON.stringify(json, null, 2)); } catch (_) {}
}

const [mode, a, b] = process.argv.slice(2);
if (mode === 'job') jobSummary(a, b || a);
else if (mode === 'diff') diffSummary(a || 'results');
else { console.error('usage: audit-summary.js job <results.json> <label> | diff <dir>'); process.exit(2); }
