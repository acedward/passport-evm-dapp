#!/usr/bin/env node
// The owner's-secrets check (the second layer of scripts/secret-scan.sh).
//
// It reads secret files IN-PROCESS from paths given in the environment, derives "needles" from
// their values, and searches this repository's working tree, its whole git history (every ref,
// commit messages included) and any extra paths for them. It prints counts and locations only:
// never a secret, never a needle, never a fragment of either.
//
//   SECRET_SCAN_FILES        colon-separated secret files: env-style (KEY=value lines) or a raw value
//   SECRET_SCAN_KEY_DIRS     colon-separated directories whose every file is a secret file (keys this
//                            project generates, e.g. ~/.config/aa-00039)
//   SECRET_SCAN_EXTRA_PATHS  colon-separated extra files or directories to search (a built bundle,
//                            an evidence folder)
//   SECRET_SCAN_REQUIRE=1    fail when no secret file is configured (the pre-push default)
//
// Needles: a mnemonic (12+ lowercase words) gives every window of 3 consecutive words, matched
// across any whitespace; a hex value (32+ hex digits) gives the hex, matched case-insensitively
// with or without 0x; any other value of 12+ characters (a keyed URL) gives the value itself and
// its path and query. Exit 0 when clean, 1 on any hit, 2 on a configuration or self-test failure.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const list = (v) =>
  (v ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => p.replace(/^~(?=\/|$)/, homedir()));
const MAX_FILE_BYTES = 50 * 1024 * 1024;

function fail(code, msg) {
  process.stderr.write(`secret-scan: ${msg}\n`);
  process.exit(code);
}

// ── needles ──────────────────────────────────────────────────────────────────

function valuesOf(text) {
  const assigned = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
    if (m) assigned.push(m[1].trim().replace(/^['"]|['"]$/g, ''));
  }
  return (assigned.length > 0 ? assigned : [text.trim()]).filter(Boolean);
}

function needlesOf(value) {
  const out = [];
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length >= 12 && words.every((w) => /^[a-z]{3,8}$/.test(w))) {
    for (let i = 0; i + 3 <= words.length; i++)
      out.push({ kind: 'mnemonic-window', text: words.slice(i, i + 3).join(' ') });
    return out;
  }
  const hex = value.replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{32,}$/.test(hex)) return [{ kind: 'hex', text: hex.toLowerCase() }];
  if (value.length >= 12) {
    out.push({ kind: 'value', text: value });
    try {
      const u = new URL(value);
      if (u.pathname.length >= 12) out.push({ kind: 'value', text: u.pathname });
      if (u.search.length >= 12) out.push({ kind: 'value', text: u.search });
    } catch {
      /* not a URL */
    }
  }
  return out;
}

function loadNeedles() {
  const files = [...list(process.env.SECRET_SCAN_FILES)];
  for (const dir of list(process.env.SECRET_SCAN_KEY_DIRS)) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isFile()) files.push(p);
    }
  }
  const needles = [];
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      fail(2, `cannot read a configured secret file (#${files.indexOf(f) + 1})`);
    }
    for (const v of valuesOf(text)) needles.push(...needlesOf(v));
  }
  return { files: files.length, needles };
}

// ── matching ─────────────────────────────────────────────────────────────────

function prepare(needles) {
  return needles.map((n) => ({ ...n, lower: n.text.toLowerCase() }));
}

/** Indices of the needles found in `text`. */
function matchAll(text, prepared) {
  const hits = [];
  const lower = text.toLowerCase();
  const collapsed = lower.includes(' ') || /\s/.test(lower) ? lower.replace(/\s+/g, ' ') : lower;
  prepared.forEach((n, i) => {
    const found =
      n.kind === 'mnemonic-window'
        ? collapsed.includes(n.lower)
        : n.kind === 'hex'
          ? lower.includes(n.lower)
          : text.includes(n.text);
    if (found) hits.push(i);
  });
  return hits;
}

function selfTest(prepared) {
  // In memory only: never written anywhere.
  for (const kind of ['mnemonic-window', 'hex', 'value']) {
    const i = prepared.findIndex((n) => n.kind === kind);
    if (i === -1) continue;
    const n = prepared[i];
    const embedded =
      kind === 'mnemonic-window'
        ? `x\n  ${n.text.split(' ').join('\t\n ')} y`
        : kind === 'hex'
          ? `k=0x${n.text.toUpperCase()};`
          : `a ${n.text} b`;
    if (!matchAll(embedded, prepared).includes(i)) return false;
  }
  return matchAll('nothing to see here 0123 abc', prepared).length === 0;
}

// ── sources ──────────────────────────────────────────────────────────────────

const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });

function* walk(p) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const f of readdirSync(p)) if (f !== '.git' && f !== 'node_modules') yield* walk(join(p, f));
  } else if (st.isFile() && st.size <= MAX_FILE_BYTES) {
    yield p;
  }
}

function main() {
  const { files, needles } = loadNeedles();
  if (files === 0) {
    if (process.env.SECRET_SCAN_REQUIRE === '1') fail(2, 'no secret files configured (set SECRET_SCAN_FILES)');
    console.log('secret-scan (owner secrets): no secret files configured; skipped');
    return;
  }
  if (needles.length === 0) fail(2, 'the configured secret files gave no usable values');
  const prepared = prepare(needles);
  if (!selfTest(prepared)) fail(2, 'self-test FAILED');

  const hits = [];
  // 1. the working tree: tracked and untracked-but-not-ignored files (the submodule is a gitlink)
  const tree = git('ls-files', '-co', '--exclude-standard', '-z').split('\0').filter(Boolean);
  let scannedFiles = 0;
  for (const rel of tree) {
    const p = join(root, rel);
    if (!existsSync(p) || !statSync(p).isFile() || statSync(p).size > MAX_FILE_BYTES) continue;
    scannedFiles++;
    for (const i of matchAll(readFileSync(p, 'latin1'), prepared))
      hits.push(`working tree ${rel} (needle #${i + 1}, ${prepared[i].kind})`);
  }
  // 2. the whole history of every ref, one commit at a time (patches and messages)
  const shas = git('rev-list', '--all').split('\n').filter(Boolean);
  for (const sha of shas) {
    const text = git('show', '--no-color', '--no-ext-diff', '--text', '--format=%H%n%an%n%ae%n%B', sha);
    for (const i of matchAll(text, prepared))
      hits.push(`commit ${sha.slice(0, 12)} (needle #${i + 1}, ${prepared[i].kind})`);
  }
  // 3. extra paths
  let extraFiles = 0;
  for (const p of list(process.env.SECRET_SCAN_EXTRA_PATHS).map((x) => resolve(root, x))) {
    if (!existsSync(p)) fail(2, `extra path does not exist: ${relative(root, p) || p}`);
    for (const f of walk(p)) {
      extraFiles++;
      for (const i of matchAll(readFileSync(f, 'latin1'), prepared))
        hits.push(`extra ${relative(root, f)} (needle #${i + 1}, ${prepared[i].kind})`);
    }
  }

  const kinds = prepared.reduce((a, n) => ((a[n.kind] = (a[n.kind] ?? 0) + 1), a), {});
  console.log(
    `secret-scan (owner secrets): ${prepared.length} needles from ${files} files (${Object.entries(kinds)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}); ` +
      `self-test PASS; scanned ${scannedFiles} working-tree files, ${shas.length} commits, ${extraFiles} extra files; hits ${hits.length}`,
  );
  if (hits.length > 0) {
    for (const h of hits) console.log(`  HIT ${h}`);
    process.exit(1);
  }
}

main();
