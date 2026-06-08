#!/usr/bin/env node
// Assemble graded report JSONs from the judge workflow's verdicts.
//
// Inputs:
//   reports/grading/manifest.json   (set/task/target/path per sample)
//   reports/grading/verdicts.json   (array: {set,id,score,faithful,correct,
//                                     fluent,cyrillicOnly,pass,refuted,reason})
//   reports/grading/<set>/<id>.json  (per-sample content for fails/flagged cards)
//
// Output: the 5 graded files build-report.mjs expects:
//   quality-graded.json, mongolian-graded.json, mongolian-improved-graded.json,
//   mongolian-reasoning-graded.json, mongolian-optimal-graded.json
//
// Usage: node scripts/grade-assemble.mjs

import { readFileSync, writeFileSync } from "node:fs";

const REPORTS = "reports";
const GDIR = `${REPORTS}/grading`;
const MODEL = process.env.MODEL || "gemma-4-31b";
const MODEL_ROOT = process.env.MODEL_ROOT || "RedHatAI/gemma-4-31B-it-NVFP4";
const TODAY = (process.env.TODAY || new Date().toISOString().slice(0, 10));

const manifest = JSON.parse(readFileSync(`${GDIR}/manifest.json`, "utf8"));
const verdicts = JSON.parse(readFileSync(`${GDIR}/verdicts.json`, "utf8"));
const vByKey = new Map(verdicts.map((v) => [`${v.set}::${v.id}`, v]));

const round = (n, d = 0) => { const p = 10 ** d; return Math.round((n + Number.EPSILON) * p) / p; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// Final pass = judge passed AND adversarial did not refute.
function finalPass(v) { return !!v && v.pass === true && v.refuted !== true; }
function isFluent(v) { return !!v && v.fluent === true && v.cyrillicOnly !== false; }

// Group manifest entries by set.
const bySet = new Map();
for (const m of manifest) {
  if (!bySet.has(m.set)) bySet.set(m.set, []);
  bySet.get(m.set).push(m);
}

const SET_META = {
  "english": { lang: "en", target: "quality-graded.json" },
  "mn-v1": { lang: "mn", target: "mongolian-graded.json", variant: "minimal-prompt (baseline)" },
  "mn-v2": { lang: "mn", target: "mongolian-improved-graded.json", variant: "improved-system-prompt" },
  "mn-v3": { lang: "mn", target: "mongolian-reasoning-graded.json", variant: "improved + reasoning + formal + keep-latin" },
  "mn-v4": { lang: "mn", target: "mongolian-optimal-graded.json", variant: "glossary+guardrail+formal+keep-latin, no thinking" },
};

for (const [set, entries] of bySet) {
  const cfg = SET_META[set];
  if (!cfg) { console.log(`(skip unknown set ${set})`); continue; }
  const lang = cfg.lang;
  const byTask = {};
  let missing = 0;
  for (const e of entries) {
    const v = vByKey.get(`${set}::${e.id}`);
    if (!v) { missing++; }
    (byTask[e.task] = byTask[e.task] || []).push({ e, v });
  }
  if (missing) console.log(`  ⚠ ${set}: ${missing} samples missing a verdict (counted as fail)`);

  const summary = {};
  let totN = 0, totPass = 0, totFluent = 0; const allScores = [];
  const flagged = []; // mn: fails or non-fluent; en: fails
  for (const task of Object.keys(byTask)) {
    const rows = byTask[task];
    const n = rows.length;
    let pass = 0, fluent = 0; const scores = [];
    for (const { e, v } of rows) {
      const p = finalPass(v);
      const score = v?.score ?? 1;
      scores.push(score);
      if (p) pass++;
      const fl = lang === "mn" ? isFluent(v) : true;
      if (fl) fluent++;
      // Collect cards: english -> fails only; mn -> fails OR non-fluent.
      const flagThis = lang === "mn" ? (!p || !fl) : !p;
      if (flagThis) {
        const content = JSON.parse(readFileSync(e.path, "utf8"));
        const card = {
          task, id: e.id,
          problem: v?.reason || (v ? "" : "no verdict"),
          question: content.question || content.instruction || "",
          injected: content.injected ? { temperature_c: content.injected.temperature_c, feels_like_c: content.injected.feels_like_c, condition: content.injected.condition } : null,
          source: content.source ? String(content.source).slice(0, 1200) : null,
          output: content.output || "",
          score, pass: p, fluent: lang === "mn" ? fl : undefined,
        };
        flagged.push(card);
      }
    }
    const s = { n, pass, passPct: round((pass / n) * 100), meanScore: round(mean(scores), 1) };
    if (lang === "mn") { s.fluentPct = round((fluent / n) * 100); }
    summary[task] = s;
    totN += n; totPass += pass; totFluent += fluent; allScores.push(...scores);
  }

  const samplesPerTask = Math.max(...Object.values(summary).map((s) => s.n));
  let out;
  if (lang === "en") {
    out = {
      meta: { generatedAt: TODAY, model: MODEL, modelRoot: MODEL_ROOT, method: "LLM-as-judge (strict grade) + adversarial verification, one pair of agents per sample", judges: totN * 2, samplesPerTask },
      overall: { total: totN, pass: totPass, meanScore: round(mean(allScores), 1) },
      summary,
      fails: flagged,
    };
  } else {
    out = {
      meta: { generatedAt: TODAY, model: MODEL, modelRoot: MODEL_ROOT, language: "Mongolian (mn)", variant: cfg.variant, method: "LLM-judge + adversarial verify (faithfulness, correctness, fluency)", samplesPerTask },
      overall: { total: totN, pass: totPass, passPct: round((totPass / totN) * 100), fluentPct: round((totFluent / totN) * 100), meanScore: round(mean(allScores), 1) },
      summary,
      flagged,
    };
  }
  writeFileSync(`${REPORTS}/${cfg.target}`, JSON.stringify(out, null, 2));
  const extra = lang === "mn" ? ` fluent=${out.overall.fluentPct}%` : "";
  console.log(`  wrote ${cfg.target}: ${totPass}/${totN} pass (mean ${out.overall.meanScore}/5${extra}), ${flagged.length} flagged`);
}
console.log("\nDone assembling graded reports.");
