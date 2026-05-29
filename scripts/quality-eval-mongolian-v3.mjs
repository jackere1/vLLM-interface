#!/usr/bin/env node
// Mongolian prompt A/B — experiment #3 (v3): the v2 improved prompt PLUS
//   (a) reasoning enabled (chat_template_kwargs.enable_thinking),
//   (b) strict formal/literary register, and
//   (c) "keep technical/brand names in Latin" (targets the v2 xsum failures
//       which were mangled transliterations).
// Same 30 samples (same questions / injected data / source docs) as v1/v2.
// Output: reports/mongolian-v3-<ts>.json  (graded by the same MN judge).
//
// Usage: node scripts/quality-eval-mongolian-v3.mjs

import { writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";

const BASE_URL = (process.env.VLLM_BASE_URL || "https://twiki-consumption-genuine-whats.trycloudflare.com/v1").replace(/\/+$/, "");
const API_KEY = process.env.VLLM_API_KEY || "a39e4fb12f8062efbb56dbb5be6fc8d3b58af30629afae586aaa8850c5ea8a0c";
const MODEL = process.env.MODEL || "gemma-4-31b";
const SRC_DIR = process.env.SRC_DIR || "reports/qsamples-mn";
const AUTH = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
const XSUM_INSTR = "Дээрх англи баримт бичгийг Монгол хэлээр 3-4 өгүүлбэрээр товчилж бичээч.";

const RULES = `ЧАНД дагах дүрэм:
1. ЗӨВХӨН монгол кирилл үсгээр бич. Англи, хятад, япон болон бусад хэлний үг, үсэг, тэмдэгтийг ОГТ бүү хэрэглэ, бүү хольж бич.
2. Зөвхөн жинхэнэ, оршин байдаг монгол үг хэрэглэ. Зохиомол үг бүү ашигла.
3. Дүрмийн хувьд зөв, ойлгомжтой, байгалийн жамаар бич.`;
const FORMAL = `Албан ёсны, бичгийн найруулгаар, нямбай бич.`;
const KEEPLATIN = `Технологи, бүтээгдэхүүн, брэндийн нэрийг (жишээ нь Next.js, React, vLLM, Vercel, SDK) бүү орчуул, бүү галигла — латин үсгээр хэвээр нь үлдээ.`;
const GLOSSARY = `Цаг агаарын нэр томьёо: overcast = бүрхэг; clear sky = цэлмэг тэнгэр; partly cloudy = багавтар үүлэрхэг; cloudy = үүлэрхэг; light rain = бороо шиврэх; light snow = цас орох; fog = манан. Шинжлэх ухаан: carbon dioxide = нүүрсхүчлийн хий.`;
const FEWSHOT = `Жишээ (цаг агаар): температур 10°C, мэдрэгдэх 8°C, нөхцөл overcast бол → «Улаанбаатарт одоо 10°C, мэдрэгдэх байдлаар 8°C байна. Тэнгэр бүрхэг байна.»`;
const SYS_WEATHER = `Чи найрсаг, товч цаг агаарын туслах. Хэрэгслийн үр дүнг үнэн зөв тусгаж нэг-хоёр өгүүлбэрээр монголоор хэл.\n${RULES}\n${FORMAL}\n${GLOSSARY}\n${FEWSHOT}`;
const SYS_GENERAL = `Чи нямбай, тустай туслах. Асуултад товч, зөв монголоор хариул.\n${RULES}\n${FORMAL}\n${GLOSSARY}`;
const SYS_TECH = `Чи нямбай туслах. Зөвхөн өгөгдсөн баримт бичигт тулгуурлан хариул.\n${RULES}\n${FORMAL}\n${KEEPLATIN}`;

async function chat(messages, maxTokens) {
  const r = await fetch(`${BASE_URL}/chat/completions`, { method: "POST", headers: AUTH, body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature: 0.3, chat_template_kwargs: { enable_thinking: true } }) });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const m = (await r.json()).choices[0].message;
  return { content: m.content || "", reasoned: !!(m.reasoning && m.reasoning.length) };
}

async function main() {
  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".json") && f !== "_items.json");
  const samples = files.map((f) => JSON.parse(readFileSync(`${SRC_DIR}/${f}`, "utf8")));
  console.log(`v3: re-running ${samples.length} Mongolian samples with reasoning + formal + keep-Latin...`);
  const out = []; let noAnswer = 0;
  for (const s of samples) {
    let res = { content: "", reasoned: false };
    try {
      if (s.task === "weather") {
        const inj = s.injected || {}; const loc = inj.location || "Улаанбаатар";
        res = await chat([
          { role: "system", content: SYS_WEATHER },
          { role: "user", content: s.question },
          { role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "get_weather", arguments: JSON.stringify({ location: loc }) } }] },
          { role: "tool", tool_call_id: "c0", content: JSON.stringify(inj) },
        ], 1024);
      } else if (s.task === "general") {
        res = await chat([{ role: "system", content: SYS_GENERAL }, { role: "user", content: s.question }], 1536);
      } else {
        res = await chat([{ role: "system", content: SYS_TECH }, { role: "user", content: `${s.source}\n\n${XSUM_INSTR}` }], 1536);
      }
    } catch (e) { res = { content: `[error: ${e.message}]`, reasoned: false }; }
    if (!res.content.trim()) noAnswer++;
    out.push({ id: s.id, task: s.task, question: s.question, injected: s.injected || null, source: s.source || null, output: res.content });
    process.stdout.write(res.content.trim() ? s.task[0] : "·");
  }
  mkdirSync("reports", { recursive: true });
  const d = new Date(); const p = (x) => String(x).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const path = `reports/mongolian-v3-${stamp}.json`;
  writeFileSync(path, JSON.stringify({ meta: { generatedAt: new Date().toISOString(), model: MODEL, variant: "improved + reasoning + formal + keep-latin", note: "same prompts as v1/v2; enable_thinking + formal register + keep technical names in Latin" }, samples: out }, null, 2));
  console.log(`\nWrote ${path} (${out.length} outputs; ${noAnswer} empty after reasoning)`);
}
main().catch((e) => { console.error("\nFatal:", e); process.exit(1); });
