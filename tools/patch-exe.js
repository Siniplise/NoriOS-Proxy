#!/usr/bin/env node
'use strict';
/* ============================================================================
 * tools/patch-exe.js —— 对**你自己的** Nori.Web.exe 打补丁（我们不分发 exe）
 *
 * 做什么
 *   Nori.Web.exe 里硬编码了 41 条"剧情事实"常量（manifold 卡带的常量元组）。
 *   本脚本把这 41 条**等长替换**成 `zzfact00…zzfact40…` 占位符，让"干净包/第一天包"
 *   能按自己的节奏推进，而不是一启动就被内置事实判成"已经通关"。
 *   默认保留 `session.ready`（冷开场过场要用它），其余 40 条替换。
 *
 * 不做什么
 *   · 不修改代码逻辑、不绕过网络校验、不改任何资源文件
 *   · 不生成、也不分发 exe —— 输出是**你自己机器上**的一份副本
 *
 * 为什么是"内容定位"而不是"字节偏移"
 *   脚本先在本机 exe 里搜索那 41 条常量的连续序列，**必须恰好命中一次**才动手。
 *   所以：版本不对 ⇒ 直接报错退出，不会写出半残的文件。
 *
 * 用法
 *   node tools/patch-exe.js "D:\Nori.Web\Nori.Web.exe"
 *   node tools/patch-exe.js "D:\Nori.Web\Nori.Web.exe" "D:\Nori.Web\Nori.Web.clean.exe"
 *   node tools/patch-exe.js --dry-run "D:\Nori.Web\Nori.Web.exe"     # 只扫描，不写
 *   NORI_KEEP_FACTS=session.ready,boot.completed node tools/patch-exe.js ...  # 多保留几条
 *   NORI_KEEP_FACTS=none node tools/patch-exe.js ...                 # 41 条全替换
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* 顺序必须与 exe 内 manifold 卡带的常量元组一致 —— 这是"内容指纹"，不是随便排的 */
const FACTS = [
  'system.repaired', 'virus.cleared', 'qfr.installed', 'compute.initialized', 'bounty.ext_installed',
  'mail.help.read', 'boot.completed', 'session.ready', 'arg.cult_truth', 'arg.gestures_complete',
  'gesture.chess', 'gesture.codenames', 'gesture.pictionary', 'gesture.cakeduel', 'arg.farewell.shown',
  'signal_daniel.unlocked', 'daniel.deadman.delivered', 'daniel.evidence_unlocked', 'daniel.retraction.downloaded',
  'download.hanyue_consent', 'futurum.doc1.downloaded', 'futurum.doc2.downloaded', 'futurum.doc3.downloaded',
  'corrupt.doc1.read', 'corrupt.doc2.read', 'corrupt.doc3.read', 'dirt.daniel', 'dirt.frank',
  'dirt.futurum_aleph_obs', 'dirt.hanyue_ssh', 'dirt.jack', 'dirt.maggie', 'file.seal_config.read',
  'file.tower_photo.read', 'qfr.seal.released', 'qfr.cult.released', 'qfr.bounty.released',
  'qfr.gestures.released', 'recover.seal_config', 'recover.tower_photo', 'recover.overclock_log',
];

function usage(code) {
  console.error('usage: node tools/patch-exe.js [--dry-run] [--force] <src.exe> [dst.exe]');
  process.exit(code == null ? 1 : code);
}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const force = argv.includes('--force');
const files = argv.filter((a) => a !== '--dry-run' && a !== '--force');
const SRC = files[0];
if (!SRC) usage(2);

const DST = files[1] || path.join(path.dirname(SRC), 'Nori.Web.clean.exe');

const KEEP = new Set(
  (process.env.NORI_KEEP_FACTS === undefined ? 'session.ready' : process.env.NORI_KEEP_FACTS)
    .split(',').map((s) => s.trim()).filter((s) => s && s !== 'none')
);

function allIdx(buf, needle) {
  const out = [];
  let i = 0;
  for (;;) {
    i = buf.indexOf(needle, i);
    if (i < 0) return out;
    out.push(i);
    i += 1;
  }
}

function placeholder(k, len) {
  let t = 'zzfact' + String(k).padStart(2, '0');
  if (t.length > len) t = t.slice(0, len);
  return (t + '...........................................').slice(0, len);
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

if (!fs.existsSync(SRC)) { console.error('src not found: ' + SRC); process.exit(1); }
if (path.resolve(SRC) === path.resolve(DST)) { console.error('dst must differ from src (refusing to overwrite the original)'); process.exit(1); }
if (fs.existsSync(DST) && !force && !dryRun) { console.error('dst exists: ' + DST + '   (use --force to overwrite)'); process.exit(1); }

const src = fs.readFileSync(SRC);
console.log('src : ' + SRC);
console.log('     ' + src.length + ' bytes  sha256=' + sha(src).slice(0, 16) + '…');

const bufs = FACTS.map((f) => Buffer.from(f, 'latin1'));
const starts = allIdx(src, bufs[0]);
console.log('scan: ' + starts.length + ' candidate start(s) for "' + FACTS[0] + '"');

/* 找"41 条按顺序、间隔 1~8 字节"的唯一连续区段 */
const runs = [];
for (const st of starts) {
  let pos = st;
  const offs = [];
  let ok = true;
  for (let k = 0; k < FACTS.length; k++) {
    if (k > 0) {
      const nx = src.indexOf(bufs[k], pos);
      const gap = nx - pos;
      if (nx < 0 || gap < 1 || gap > 8) { ok = false; break; }
      pos = nx;
    }
    offs.push(pos);
    pos += bufs[k].length;
  }
  if (ok) runs.push({ st: st, offs: offs });
}

if (runs.length !== 1) {
  console.error('\n✗ expected exactly 1 contiguous run, found ' + runs.length);
  console.error('  → this exe is probably a different build than the one we target.');
  console.error('  → do NOT force it; check the version in README first.');
  process.exit(1);
}

const run = runs[0];
const end = run.offs[FACTS.length - 1] + bufs[bufs.length - 1].length;
console.log('run : ' + run.st + '..' + end + '  (' + (end - run.st) + ' bytes, contiguous)');

const kept = [];
if (dryRun) {
  console.log('\n[dry-run] would replace ' + (FACTS.length - kept.length) + ' constant(s); no file written.');
  process.exit(0);
}

const out = Buffer.from(src);
for (let k = 0; k < FACTS.length; k++) {
  if (KEEP.has(FACTS[k])) { kept.push(FACTS[k]); continue; }
  const len = bufs[k].length;
  const p = Buffer.from(placeholder(k, len), 'latin1');
  if (p.length !== len) { console.error('internal: length mismatch at ' + k); process.exit(1); }
  p.copy(out, run.offs[k]);
}

fs.writeFileSync(DST, out);
console.log('\nwrote ' + DST + '  ' + out.length + ' bytes  sha256=' + sha(out).slice(0, 16) + '…');
console.log('kept intact: ' + (kept.length ? kept.join(', ') : '(none)'));

/* 回读校验：替换的必须是占位符，保留的必须原样 */
const chk = fs.readFileSync(DST);
let bad = 0;
for (let k = 0; k < FACTS.length; k++) {
  const got = chk.slice(run.offs[k], run.offs[k] + bufs[k].length).toString('latin1');
  const want = KEEP.has(FACTS[k]) ? FACTS[k] : placeholder(k, bufs[k].length);
  if (got !== want) { console.error('verify FAILED at #' + k + ' ' + FACTS[k]); bad++; }
}
if (bad) process.exit(2);
console.log('verify OK: ' + (FACTS.length - kept.length) + ' replaced, ' + kept.length + ' kept');
