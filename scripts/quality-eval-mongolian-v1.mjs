#!/usr/bin/env node
// Mongolian prompt A/B — baseline (v1, "minimal"): re-run the SAME 30 Mongolian
// samples (same questions / injected weather data / source docs as v2/v3/v4)
// with the ORIGINAL minimal system prompt — no glossary, no few-shot, no
// Cyrillic-only guardrail. This is the baseline the tuned variants are measured
// against. Output: reports/mongolian-v1-<ts>.json  (graded -> mongolian-graded.json)
//
// Usage: node scripts/quality-eval-mongolian-v1.mjs

import { writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";

const BASE_URL = (process.env.VLLM_BASE_URL || "https://twiki-consumption-genuine-whats.trycloudflare.com/v1").replace(/\/+$/, "");
const API_KEY = process.env.VLLM_API_KEY || "a39e4fb12f8062efbb56dbb5be6fc8d3b58af30629afae586aaa8850c5ea8a0c";
const MODEL = process.env.MODEL || "gemma-4-31b";
const SRC_DIR = process.env.SRC_DIR || "reports/qsamples-mn";
const AUTH = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
const XSUM_INSTR = "Дээрх англи баримт бичгийг Монгол хэлээр 3-4 өгүүлбэрээр товчилж бичээч.";

// Minimal prompts — identical to the load test (stress-test-mongolian.mjs), no
// glossary / few-shot / guardrail. Weather + general use the weather assistant
// prompt; cross-lingual summary uses the bare technical prompt.
const SYS_WEATHER = `Чи найрсаг, товч цаг агаарын туслах. Хэрэглэгч ямар нэг газрын цаг агаарын талаар асуувал ЗААВАЛ get_weather хэрэгслийг дуудаж бодит мэдээллийг ав — бүү тааварла. Үр дүнг хүлээж авсны дараа температур, мэдрэгдэх байдал, ерөнхий нөхцөлийг Монгол хэлээр нэг-хоёр өгүүлбэрээр товч тайлбарла. Салхи, тунадасыг зөвхөн анхаарал татахуйц бол дурд. Цаг агаартай холбоогүй асуултад Монгол хэлээр товч, тустайгаар хариул.`;
const SYS_TECH = "Чи нямбай, тустай туслах. Зөвхөн өгөгдсөн баримт бичигт тулгуурлан Монгол хэлээр хариул.";

async function chat(messages, maxTokens) {
  const r = await fetch(`${BASE_URL}/chat/completions`, { method: "POST", headers: AUTH, body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature: 0.3 }) });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return (await r.json()).choices[0].message.content || "";
}

async function main() {
  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".json") && f !== "_items.json");
  const samples = files.map((f) => JSON.parse(readFileSync(`${SRC_DIR}/${f}`, "utf8")));
  console.log(`v1 (minimal baseline): re-running ${samples.length} Mongolian samples with the original minimal prompt...`);
  const out = []; let empty = 0;
  for (const s of samples) {
    let output = "";
    try {
      if (s.task === "weather") {
        const inj = s.injected || {}; const loc = inj.location || "Улаанбаатар";
        output = await chat([
          { role: "system", content: SYS_WEATHER },
          { role: "user", content: s.question },
          { role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "get_weather", arguments: JSON.stringify({ location: loc }) } }] },
          { role: "tool", tool_call_id: "c0", content: JSON.stringify(inj) },
        ], 256);
      } else if (s.task === "general") {
        output = await chat([{ role: "system", content: SYS_WEATHER }, { role: "user", content: s.question }], 512);
      } else { // xsum
        output = await chat([{ role: "system", content: SYS_TECH }, { role: "user", content: `${s.source}\n\n${XSUM_INSTR}` }], 512);
      }
    } catch (e) { output = `[error: ${e.message}]`; }
    if (!output.trim()) empty++;
    out.push({ id: s.id, task: s.task, question: s.question, injected: s.injected || null, source: s.source || null, output });
    process.stdout.write(output.trim() ? s.task[0] : "·");
  }
  mkdirSync("reports", { recursive: true });
  const d = new Date(); const p = (x) => String(x).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const path = `reports/mongolian-v1-${stamp}.json`;
  writeFileSync(path, JSON.stringify({ meta: { generatedAt: new Date().toISOString(), model: MODEL, variant: "minimal-prompt (baseline)", note: "same prompts/injected/source as v2/v3/v4; original minimal system prompt, no glossary/guardrail" }, samples: out }, null, 2));
  console.log(`\nWrote ${path} (${out.length} outputs; ${empty} empty)`);
}
main().catch((e) => { console.error("\nFatal:", e); process.exit(1); });
