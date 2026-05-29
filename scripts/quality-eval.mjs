#!/usr/bin/env node
// Captures FULL input->output pairs on REAL prompts across the meaningful task
// types (weather tool round-trip, off-topic chat, summarization, long-context
// reasoning) so output quality can be graded. Unlike the load tests, this is
// correctness-focused: sequential, low temperature, full (untruncated) outputs.
//
// Output: reports/quality-eval-<ts>.json  (then graded by the judge workflow).
//
// Usage: node scripts/quality-eval.mjs   [N_PER_TASK=8]

import { writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { CHUNKS, SUMMARIZE_TEMPLATES, COMPLEX_QUESTIONS } from "./longctx-corpus.mjs";

const BASE_URL = (process.env.VLLM_BASE_URL || "https://twiki-consumption-genuine-whats.trycloudflare.com/v1").replace(/\/+$/, "");
const ROOT = BASE_URL.replace(/\/v1$/, "");
const API_KEY = process.env.VLLM_API_KEY || "a39e4fb12f8062efbb56dbb5be6fc8d3b58af30629afae586aaa8850c5ea8a0c";
const MODEL = process.env.MODEL || "gemma-4-31b";
const N = Number(process.env.N_PER_TASK || 8);
const AUTH = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

const SYSTEM_WEATHER = `You are a friendly, concise weather assistant.

When the user asks about the weather in a place, ALWAYS call the get_weather tool to fetch real, current conditions — do not guess. After you receive the tool result, summarise it in plain English in one or two sentences: temperature, what it feels like, and the overall condition. Mention wind or precipitation only if notable.

For non-weather questions, answer briefly and helpfully.`;
const SYSTEM_TECH = "You are a precise, helpful technical assistant. Answer using only the provided documentation.";
const TOOLS = [{ type: "function", function: { name: "get_weather", description: "Get the current real-world weather for a city or location.", parameters: { type: "object", properties: { location: { type: "string", description: "City name." } }, required: ["location"] } } }];

const CITIES = ["Tokyo", "Paris", "Reykjavik", "Nairobi", "Sydney", "Toronto", "Mumbai", "Lima", "Oslo", "Cairo", "Singapore", "Denver"];
const WEATHER_Q = [(c) => `What's the weather in ${c} right now?`, (c) => `Is it cold in ${c} today, and will I need a jacket?`, (c) => `How are conditions in ${c} at the moment?`];
const OFFTOPIC_Q = [
  "Explain the difference between TCP and UDP in two sentences.",
  "Write a one-line haiku about debugging.",
  "What's a quick, healthy lunch I can make in 10 minutes?",
  "In plain terms, what is a race condition in concurrent code?",
  "Suggest three names for a productivity app and why.",
  "What's the capital of Australia, and one fact about it?",
  "Summarize the plot of Romeo and Juliet in two sentences.",
  "Give me a simple analogy for how DNS works.",
  "What are two pros and two cons of remote work?",
  "Explain recursion to a beginner with a short example.",
];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function strhash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function cannedWeather(location) {
  const h = strhash(location);
  const cond = ["Clear sky", "Partly cloudy", "Overcast", "Light rain", "Moderate rain", "Light snow", "Fog"];
  const t = -5 + (h % 38);
  return { location, temperature_c: t, feels_like_c: t - (h % 4), humidity_pct: 35 + (h % 60), wind_kmh: h % 35, precipitation_mm: (h % 5) === 0 ? (h % 12) / 10 : 0, is_day: (h % 2) === 0, condition: cond[h % cond.length] };
}

async function tokenize(text) { const r = await fetch(`${ROOT}/tokenize`, { method: "POST", headers: AUTH, body: JSON.stringify({ model: MODEL, prompt: text }) }); return (await r.json()).count; }
let chunkTokens = [];
function assembleDoc(target) {
  const order = CHUNKS.map((_, i) => i).sort(() => Math.random() - 0.5);
  const parts = []; let toks = 12, i = 0;
  while (toks < target && i < 60) { const idx = order[i % order.length]; parts.push(`## ${CHUNKS[idx].title}\n${CHUNKS[idx].text}`); toks += chunkTokens[idx]; i++; }
  return `[doc:${randomBytes(4).toString("hex")}]\n\n${parts.join("\n\n")}`;
}

async function chat(messages, { tools, maxTokens, temp }) {
  const body = { model: MODEL, messages, max_tokens: maxTokens, temperature: temp };
  if (tools) { body.tools = TOOLS; body.tool_choice = "auto"; }
  const res = await fetch(`${BASE_URL}/chat/completions`, { method: "POST", headers: AUTH, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json(); const m = j.choices[0].message;
  return { content: m.content || "", toolCalls: m.tool_calls || [], finish: j.choices[0].finish_reason };
}

async function main() {
  console.log(`Quality-eval capture: ${N} samples/task, model ${MODEL}`);
  chunkTokens = []; for (const c of CHUNKS) chunkTokens.push(await tokenize(`## ${c.title}\n${c.text}`));

  const samples = []; let id = 0;
  const add = (o) => { samples.push({ id: `${o.task[0]}${++id}`, ...o }); process.stdout.write("."); };

  // Weather (tool round-trip) — capture the injected data + the final summary.
  for (let i = 0; i < N; i++) {
    const city = CITIES[i % CITIES.length]; const q = pick(WEATHER_Q)(city);
    const m1 = await chat([{ role: "system", content: SYSTEM_WEATHER }, { role: "user", content: q }], { tools: true, maxTokens: 200, temp: 0.3 });
    let summary = m1.content, injected = null, toolCalled = m1.toolCalls.length > 0, loc = null;
    if (toolCalled) {
      const tc = m1.toolCalls[0]; loc = city; try { loc = JSON.parse(tc.function.arguments).location || city; } catch {}
      injected = cannedWeather(loc);
      const m2 = await chat([{ role: "system", content: SYSTEM_WEATHER }, { role: "user", content: q }, { role: "assistant", content: null, tool_calls: [{ id: tc.id || "c0", type: "function", function: tc.function }] }, { role: "tool", tool_call_id: tc.id || "c0", content: JSON.stringify(injected) }], { maxTokens: 220, temp: 0.3 });
      summary = m2.content;
    }
    add({ task: "weather", question: q, injected, toolCalled, location: loc, output: summary });
  }
  // Off-topic general chat.
  for (let i = 0; i < N; i++) {
    const q = OFFTOPIC_Q[i % OFFTOPIC_Q.length];
    const m = await chat([{ role: "system", content: SYSTEM_WEATHER }, { role: "user", content: q }], { maxTokens: 400, temp: 0.5 });
    add({ task: "offtopic", question: q, toolCalled: m.toolCalls.length > 0, output: m.content });
  }
  // Summarization over real docs.
  for (let i = 0; i < N; i++) {
    const doc = assembleDoc(1200); const instr = pick(SUMMARIZE_TEMPLATES);
    const m = await chat([{ role: "system", content: SYSTEM_TECH }, { role: "user", content: `${instr}\n\n${doc}` }], { maxTokens: 400, temp: 0.3 });
    add({ task: "summarize", instruction: instr, source: doc, output: m.content });
  }
  // Long-context reasoning over real docs.
  for (let i = 0; i < N; i++) {
    const doc = assembleDoc(1400); const q = pick(COMPLEX_QUESTIONS);
    const m = await chat([{ role: "system", content: SYSTEM_TECH }, { role: "user", content: `${doc}\n\n${q}` }], { maxTokens: 768, temp: 0.4 });
    add({ task: "longctx", instruction: q, source: doc, output: m.content });
  }

  mkdirSync("reports", { recursive: true });
  const d = new Date(); const p = (x) => String(x).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const path = `reports/quality-eval-${stamp}.json`;
  writeFileSync(path, JSON.stringify({ meta: { generatedAt: new Date().toISOString(), model: MODEL, nPerTask: N, total: samples.length }, samples }, null, 2));
  console.log(`\nWrote ${path} (${samples.length} full input→output samples)`);
}
main().catch((e) => { console.error("\nFatal:", e); process.exit(1); });
