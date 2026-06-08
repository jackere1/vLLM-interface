#!/usr/bin/env node
// Grading prep: split the latest capture JSONs into self-describing per-sample
// files under reports/grading/<set>/<id>.json, plus a manifest. The judge
// workflow then spawns a judge + adversarial verifier per file.
//
// Sets: english (quality-eval), mn-v1..mn-v4 (Mongolian prompt variants).
//
// Usage: node scripts/grade-prep.mjs

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";

const REPORTS = "reports";
const GDIR = `${REPORTS}/grading`;

function latest(prefix) {
  const files = readdirSync(REPORTS).filter((f) => f.startsWith(prefix) && f.endsWith(".json"));
  if (!files.length) return null;
  files.sort();
  return `${REPORTS}/${files[files.length - 1]}`;
}

// set -> { capturePrefix, lang, variant, target (final graded filename) }
const SETS = [
  { set: "english", prefix: "quality-eval-", lang: "en", variant: "english", target: "quality-graded.json" },
  { set: "mn-v1", prefix: "mongolian-v1-", lang: "mn", variant: "minimal-prompt (baseline)", target: "mongolian-graded.json" },
  { set: "mn-v2", prefix: "mongolian-v2-", lang: "mn", variant: "improved-system-prompt", target: "mongolian-improved-graded.json" },
  { set: "mn-v3", prefix: "mongolian-v3-", lang: "mn", variant: "improved + reasoning + formal + keep-latin", target: "mongolian-reasoning-graded.json" },
  { set: "mn-v4", prefix: "mongolian-v4-", lang: "mn", variant: "glossary+guardrail+formal+keep-latin, no thinking", target: "mongolian-optimal-graded.json" },
];

if (existsSync(GDIR)) rmSync(GDIR, { recursive: true, force: true });
mkdirSync(GDIR, { recursive: true });

const manifest = [];
for (const s of SETS) {
  const path = latest(s.prefix);
  if (!path) { console.log(`  (missing capture for ${s.set} — prefix ${s.prefix}*)`); continue; }
  const data = JSON.parse(readFileSync(path, "utf8"));
  const samples = data.samples || [];
  mkdirSync(`${GDIR}/${s.set}`, { recursive: true });
  for (const smp of samples) {
    const rec = {
      set: s.set, lang: s.lang, variant: s.variant, target: s.target,
      id: smp.id, task: smp.task,
      question: smp.question ?? smp.instruction ?? null,
      instruction: smp.instruction ?? null,
      injected: smp.injected ?? null,
      location: smp.location ?? null,
      source: smp.source ?? null,
      toolCalled: smp.toolCalled ?? null,
      output: smp.output ?? "",
    };
    const fp = `${GDIR}/${s.set}/${smp.id}.json`;
    writeFileSync(fp, JSON.stringify(rec, null, 2));
    manifest.push({ set: s.set, lang: s.lang, variant: s.variant, target: s.target, id: smp.id, task: smp.task, path: `${process.cwd()}/${fp}` });
  }
  console.log(`  ${s.set}: ${samples.length} samples from ${path}`);
}

writeFileSync(`${GDIR}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`\nWrote ${manifest.length} per-sample grading files + ${GDIR}/manifest.json`);
console.log(`Sets: ${[...new Set(manifest.map((m) => m.set))].join(", ")}`);
