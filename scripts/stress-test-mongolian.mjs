#!/usr/bin/env node
// vLLM Mongolian-language pillar: load + quality.
//
// Drives Mongolian (Монгол, Cyrillic) prompts across three agentic tasks:
//   - weather:   Mongolian weather question -> get_weather tool round-trip -> Mongolian summary
//   - general:   Mongolian knowledge/explanation Q&A
//   - xsum:      cross-lingual — summarize a real ENGLISH doc IN Mongolian
// Measures latency/throughput/tool-accuracy/KV under a (modest) concurrency
// sweep, records the Mongolian-vs-English token overhead, and captures FULL
// Mongolian outputs (with ground truth) so quality/fluency can be graded and
// you can spot-check the actual text.
//
// Output: reports/mongolian-<ts>.json  (cells = load metrics, samples = full I/O)
//
// Usage: node scripts/stress-test-mongolian.mjs   (QUICK=1 for a smoke run)

import { writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { CHUNKS } from "./longctx-corpus.mjs";

const QUICK = process.env.QUICK === "1";
const BASE_URL = (process.env.VLLM_BASE_URL || "https://twiki-consumption-genuine-whats.trycloudflare.com/v1").replace(/\/+$/, "");
const ROOT = BASE_URL.replace(/\/v1$/, "");
const API_KEY = process.env.VLLM_API_KEY || "a39e4fb12f8062efbb56dbb5be6fc8d3b58af30629afae586aaa8850c5ea8a0c";
const MODEL = process.env.MODEL || "gemma-4-31b";
const CONCURRENCIES = parseList(process.env.CONCURRENCIES, QUICK ? [3] : [5, 10, 20]);
const REQS_PER_CONC = num(process.env.REQS_PER_CONC, 6);
const reqsForConc = (c) => (QUICK ? 3 : REQS_PER_CONC * c);
const MAX_TOKENS = num(process.env.MAX_TOKENS, 512);
const WARMUP = num(process.env.WARMUP, QUICK ? 0 : 2);
const COOLDOWN_MS = num(process.env.COOLDOWN_MS, QUICK ? 500 : 2000);
const REQUEST_TIMEOUT_MS = num(process.env.REQUEST_TIMEOUT_MS, 120000);
const CAPTURE_PER_TASK = num(process.env.CAPTURE_PER_TASK, QUICK ? 1 : 10); // full outputs kept for grading
const AUTH = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
let serverFingerprint = null;

const SYSTEM_WEATHER = `Чи найрсаг, товч цаг агаарын туслах. Хэрэглэгч ямар нэг газрын цаг агаарын талаар асуувал ЗААВАЛ get_weather хэрэгслийг дуудаж бодит мэдээллийг ав — бүү тааварла. Үр дүнг хүлээж авсны дараа температур, мэдрэгдэх байдал, ерөнхий нөхцөлийг Монгол хэлээр нэг-хоёр өгүүлбэрээр товч тайлбарла. Салхи, тунадасыг зөвхөн анхаарал татахуйц бол дурд. Цаг агаартай холбоогүй асуултад Монгол хэлээр товч, тустайгаар хариул.`;
const SYSTEM_TECH = "Чи нямбай, тустай туслах. Зөвхөн өгөгдсөн баримт бичигт тулгуурлан Монгол хэлээр хариул.";
const TOOLS = [{ type: "function", function: { name: "get_weather", description: "Get the current real-world weather for a city or location.", parameters: { type: "object", properties: { location: { type: "string", description: "City name." } }, required: ["location"] } } }];

const CITIES = ["Улаанбаатар", "Дархан", "Эрдэнэт", "Чойбалсан", "Мөрөн", "Ховд", "Токио", "Парис", "Лондон", "Москва", "Бээжин", "Сөүл", "Берлин", "Нью-Йорк"];
const WEATHER_Q = [
  (c) => `${c}-д одоо цаг агаар ямар байна?`,
  (c) => `${c}-д өнөөдөр хүйтэн үү, хүрэм өмсөх үү?`,
  (c) => `${c} хотод одоо бороо орж байна уу?`,
  (c) => `${c}-гийн агаарын температур хэд байна вэ?`,
];
const GENERAL_Q = [
  "Фотосинтез гэж юу вэ? Энгийнээр тайлбарлаач.",
  "Нарны аймагт хэдэн гариг байдаг вэ?",
  "Усны эргэлт (water cycle) гэж юу вэ?",
  "Рекурс (recursion) гэж юу вэ? Богино жишээтэйгээр тайлбарла.",
  "TCP болон UDP протоколын гол ялгаа юу вэ?",
  "Хиймэл оюун ухаан гэж юу вэ? Хоёр өгүүлбэрээр тайлбарла.",
  "Эрүүл хооллолтын тухай гурван богино зөвлөгөө өгөөч.",
  "Дэлхийн хамгийн өндөр уул аль вэ?",
  "Татварын орлого гэж юу вэ? Энгийнээр тайлбарла.",
  "Цаг агаар, уур амьсгал хоёрын ялгааг тайлбарлаач.",
];
const XSUM_INSTR = "Дээрх англи баримт бичгийг Монгол хэлээр 3-4 өгүүлбэрээр товчилж бичээч.";

function parseList(v, d) { if (!v) return d; return v.split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite); }
function num(v, d) { const n = v == null ? NaN : Number(v); return Number.isFinite(n) ? n : d; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function pct(s, p) { if (!s.length) return null; return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]; }
function fmt(n, d = 1) { if (n == null || Number.isNaN(n)) return "—"; return Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); }
function ts() { const d = new Date(); const p = (x) => String(x).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function strhash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function cannedWeather(loc) { const h = strhash(loc); const cond = ["clear sky", "partly cloudy", "overcast", "light rain", "light snow", "fog"]; const t = -20 + (h % 38); return { location: loc, temperature_c: t, feels_like_c: t - (h % 5), humidity_pct: 35 + (h % 60), wind_kmh: h % 35, precipitation_mm: (h % 4) === 0 ? (h % 12) / 10 : 0, condition: cond[h % cond.length] }; }

async function tokenize(t) { const r = await fetch(`${ROOT}/tokenize`, { method: "POST", headers: AUTH, body: JSON.stringify({ model: MODEL, prompt: t }) }); return (await r.json()).count; }
async function fetchModelInfo() { try { const r = await fetch(`${BASE_URL}/models`, { headers: AUTH }); if (!r.ok) return null; const j = await r.json(); return j.data?.find((m) => m.id === MODEL) || j.data?.[0]; } catch { return null; } }
function metricVal(t, n) { const m = t.match(new RegExp("^" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{[^}]*\\}\\s+([-0-9.eE+]+)", "m")); return m ? Number(m[1]) : null; }
async function sampleMetrics() { try { const r = await fetch(`${ROOT}/metrics`, { headers: AUTH }); if (!r.ok) return null; const t = await r.text(); return { queries: metricVal(t, "vllm:prefix_cache_queries_total"), hits: metricVal(t, "vllm:prefix_cache_hits_total"), kv: metricVal(t, "vllm:kv_cache_usage_perc"), waiting: metricVal(t, "vllm:num_requests_waiting") }; } catch { return null; } }

let chunkTokens = [];
function englishDoc(target) { const order = CHUNKS.map((_, i) => i).sort(() => Math.random() - 0.5); const parts = []; let toks = 12, i = 0; while (toks < target && i < 40) { const idx = order[i % order.length]; parts.push(`## ${CHUNKS[idx].title}\n${CHUNKS[idx].text}`); toks += chunkTokens[idx]; i++; } return `[doc:${randomBytes(4).toString("hex")}]\n\n${parts.join("\n\n")}`; }

async function streamChat(messages, withTools) {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  const t0 = performance.now(); let tFirst = null, tEnd = null, usage = null, finish = null, content = ""; const toolAcc = {};
  const body = { model: MODEL, messages, stream: true, stream_options: { include_usage: true }, temperature: 0.3, max_tokens: MAX_TOKENS };
  if (withTools) { body.tools = TOOLS; body.tool_choice = "auto"; }
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, { method: "POST", headers: { ...AUTH, "Cache-Control": "no-cache" }, body: JSON.stringify(body), signal: ac.signal });
    if (!res.ok) { const b = await res.text().catch(() => ""); clearTimeout(timer); return { ok: false, status: res.status, error: b.slice(0, 200) }; }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    while (true) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let nl;
      while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line.startsWith("data:")) continue; const data = line.slice(5).trim(); if (data === "[DONE]") { tEnd = performance.now(); continue; }
        let j; try { j = JSON.parse(data); } catch { continue; } if (j.system_fingerprint && !serverFingerprint) serverFingerprint = j.system_fingerprint; if (j.usage) usage = j.usage; const ch = j.choices?.[0]; if (!ch) continue; if (ch.finish_reason) finish = ch.finish_reason; const d = ch.delta || {};
        if (d.content) { if (tFirst === null) tFirst = performance.now(); content += d.content; }
        if (d.tool_calls) { if (tFirst === null) tFirst = performance.now(); for (const tc of d.tool_calls) { const i = tc.index ?? 0; toolAcc[i] = toolAcc[i] || { id: null, name: null, args: "" }; if (tc.id) toolAcc[i].id = tc.id; if (tc.function?.name) toolAcc[i].name = tc.function.name; if (tc.function?.arguments) toolAcc[i].args += tc.function.arguments; } } } }
    clearTimeout(timer); if (tEnd === null) tEnd = performance.now();
    return { ok: true, ttft: tFirst !== null ? tFirst - t0 : null, latency: tEnd - t0, content, toolCalls: Object.values(toolAcc), usage, finish };
  } catch (e) { clearTimeout(timer); return { ok: false, status: 0, error: e.name === "AbortError" ? "timeout" : String(e.message || e) }; }
}

async function doRequest(spec) {
  const t0 = performance.now();
  if (spec.task === "weather") {
    const sys = { role: "system", content: SYSTEM_WEATHER }; const user = { role: "user", content: spec.text };
    const r1 = await streamChat([sys, user], true);
    if (!r1.ok) return { ok: false, task: "weather", ...r1 };
    const toolCalled = r1.toolCalls.length > 0; let r2 = null, injected = null, loc = null;
    if (toolCalled) { const tc = r1.toolCalls[0]; loc = spec.city; try { loc = JSON.parse(tc.args).location || spec.city; } catch {} injected = cannedWeather(loc);
      r2 = await streamChat([sys, user, { role: "assistant", content: null, tool_calls: [{ id: tc.id || "c0", type: "function", function: { name: tc.name || "get_weather", arguments: tc.args || "{}" } }] }, { role: "tool", tool_call_id: tc.id || "c0", content: JSON.stringify(injected) }], false); }
    const tEnd = performance.now(); const out = (r1.usage?.completion_tokens || 0) + (r2?.usage?.completion_tokens || 0);
    const dMs = (r1.latency - (r1.ttft || 0)) + (r2 ? r2.latency - (r2.ttft || 0) : 0);
    return { ok: true, task: "weather", toolCalled, ttft: r1.ttft, e2e: tEnd - t0, outputTokens: out, promptTokens: r1.usage?.prompt_tokens || null, decodeTps: dMs > 0 ? out / (dMs / 1000) : null, question: spec.text, injected, location: loc, output: (r2?.content ?? r1.content) || "" };
  }
  const sys = { role: "system", content: spec.task === "xsum" ? SYSTEM_TECH : SYSTEM_WEATHER };
  const r = await streamChat([sys, { role: "user", content: spec.text }], false);
  if (!r.ok) return { ok: false, task: spec.task, ...r };
  const dMs = r.latency - (r.ttft || 0); const out = r.usage?.completion_tokens || 0;
  return { ok: true, task: spec.task, toolCalled: r.toolCalls.length > 0, ttft: r.ttft, e2e: r.latency, outputTokens: out, promptTokens: r.usage?.prompt_tokens || null, decodeTps: dMs > 0 ? out / (dMs / 1000) : null, question: spec.task === "general" ? spec.text : XSUM_INSTR, source: spec.source || null, output: r.content };
}

function buildSpec(i) {
  const roll = i % 5; // 0,1 weather; 2,3 general; 4 xsum  -> 40/40/20
  if (roll < 2) { const city = pick(CITIES); return { task: "weather", city, text: pick(WEATHER_Q)(city) }; }
  if (roll < 4) { return { task: "general", text: pick(GENERAL_Q) }; }
  const doc = englishDoc(1100); return { task: "xsum", source: doc, text: `${doc}\n\n${XSUM_INSTR}` };
}

async function runPool(specs, concurrency, onTick) {
  const recs = []; let idx = 0;
  async function worker() { while (true) { const i = idx++; if (i >= specs.length) return; const r = await doRequest(specs[i]); recs.push(r); if (onTick) onTick(r); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, specs.length) }, worker));
  return recs;
}

function aggregate(concurrency, records, dur, cache, peak) {
  const ok = records.filter((r) => r.ok); const failed = records.filter((r) => !r.ok);
  const weather = ok.filter((r) => r.task === "weather");
  const ttfts = ok.map((r) => r.ttft).filter((x) => x != null).sort((a, b) => a - b);
  const e2es = ok.map((r) => r.e2e).filter((x) => x != null).sort((a, b) => a - b);
  const wallS = dur / 1000; const totalOut = ok.reduce((s, r) => s + (r.outputTokens || 0), 0);
  return {
    concurrency, requested: records.length, succeeded: ok.length, failed: failed.length,
    successPct: records.length ? (ok.length / records.length) * 100 : 0,
    weatherToolRatePct: weather.length ? (weather.filter((r) => r.toolCalled).length / weather.length) * 100 : null,
    meanPromptTokens: mean(ok.map((r) => r.promptTokens)), meanOutputTokens: mean(ok.map((r) => r.outputTokens)),
    ttft: { p50: pct(ttfts, 50), p95: pct(ttfts, 95) }, e2e: { p50: pct(e2es, 50), p95: pct(e2es, 95) },
    decodeTpsPerReq: mean(ok.map((r) => r.decodeTps).filter((x) => x != null)),
    aggOutputTps: wallS > 0 ? totalOut / wallS : null, achievedReqPerSec: wallS > 0 ? ok.length / wallS : null,
    prefixCacheHitPct: cache && cache.dq > 0 ? (cache.dh / cache.dq) * 100 : null,
    peakKvUsagePct: peak ? peak.kv * 100 : null, peakWaiting: peak?.waiting ?? null,
    errorsSample: failed.slice(0, 5).map((f) => ({ status: f.status, error: f.error })),
  };
}

async function main() {
  console.log(`vLLM Mongolian pillar${QUICK ? " (QUICK)" : ""}: concurrency [${CONCURRENCIES.join(", ")}], ${QUICK ? 3 : REQS_PER_CONC + "×c"} reqs/cell`);
  const modelInfo = await fetchModelInfo();
  const mtext = await fetch(`${ROOT}/metrics`, { headers: AUTH }).then((r) => (r.ok ? r.text() : "")).catch(() => "");
  const cfg = mtext.match(/vllm:cache_config_info\{([^}]*)\}/);
  const kvBlocks = cfg ? Number((cfg[1].match(/num_gpu_blocks="(\d+)"/) || [])[1]) || null : null;
  const blockSize = cfg ? Number((cfg[1].match(/block_size="(\d+)"/) || [])[1]) || null : null;

  console.log("Tokenizing corpus + measuring MN/EN token overhead...");
  chunkTokens = []; for (const c of CHUNKS) chunkTokens.push(await tokenize(`## ${c.title}\n${c.text}`));
  const pairs = [["What is the weather in Ulaanbaatar right now?", "Улаанбаатарт одоо цаг агаар ямар байна?"], ["Explain photosynthesis simply.", "Фотосинтезийг энгийнээр тайлбарлаач."], ["What is the difference between TCP and UDP?", "TCP болон UDP-ийн ялгаа юу вэ?"]];
  const ratios = []; for (const [en, mn] of pairs) { const e = await tokenize(en), m = await tokenize(mn); ratios.push(m / e); }
  const tokenOverhead = mean(ratios);
  console.log(`  MN/EN token ratio ≈ ${tokenOverhead.toFixed(2)}× (Mongolian costs ${Math.round((tokenOverhead - 1) * 100)}% more tokens)`);

  if (WARMUP > 0) await runPool(Array.from({ length: WARMUP }, (_, i) => buildSpec(i)), Math.min(WARMUP, 2));

  const cells = []; const captured = { weather: [], general: [], xsum: [] };
  for (const conc of CONCURRENCIES) {
    const n = reqsForConc(conc); const specs = Array.from({ length: n }, (_, i) => buildSpec(i));
    const before = await sampleMetrics(); const peak = { kv: 0, waiting: 0 }; let polling = true;
    const poller = (async () => { while (polling) { const m = await sampleMetrics(); if (m) { peak.kv = Math.max(peak.kv, m.kv ?? 0); peak.waiting = Math.max(peak.waiting, m.waiting ?? 0); } await sleep(700); } })();
    process.stdout.write(`c=${conc} n=${n}  `);
    const start = performance.now();
    const recs = await runPool(specs, conc, (r) => { process.stdout.write(r.ok ? (r.task === "weather" ? "w" : r.task === "xsum" ? "x" : "g") : "!"); if (r.ok && captured[r.task] && captured[r.task].length < CAPTURE_PER_TASK) captured[r.task].push(r); });
    const dur = performance.now() - start; polling = false; await poller; const after = await sampleMetrics();
    const cache = before && after ? { dq: after.queries - before.queries, dh: after.hits - before.hits } : null;
    const agg = aggregate(conc, recs, dur, cache, peak); cells.push(agg);
    console.log(`  done ${fmt(dur / 1000, 1)}s  TTFTp50=${fmt(agg.ttft.p50, 0)}ms  E2Ep50=${fmt(agg.e2e.p50 / 1000, 2)}s  req/s=${fmt(agg.achievedReqPerSec, 2)}  toolAcc=${fmt(agg.weatherToolRatePct, 0)}%  peakKV=${fmt(agg.peakKvUsagePct, 0)}%  ok=${agg.succeeded}/${agg.requested}`);
    if (COOLDOWN_MS) await sleep(COOLDOWN_MS);
  }

  // Flatten captured full-output samples for grading/spot-check.
  let sid = 0; const samples = [];
  for (const task of ["weather", "general", "xsum"]) for (const r of captured[task]) samples.push({ id: `${task[0]}${++sid}`, task, question: r.question, injected: r.injected || null, source: r.source ? r.source.slice(0, 4000) : null, output: r.output });

  const meta = { generatedAt: new Date().toISOString(), language: "Mongolian (mn)", baseUrl: BASE_URL, model: MODEL, modelRoot: modelInfo?.root ?? null, maxModelLen: modelInfo?.max_model_len ?? null, serverFingerprint, kvCapacityTokens: kvBlocks && blockSize ? kvBlocks * blockSize : null, tokenOverhead, concurrencies: CONCURRENCIES, reqsPerConc: REQS_PER_CONC, node: process.version, quick: QUICK };
  mkdirSync("reports", { recursive: true });
  const stamp = ts();
  writeFileSync(`reports/mongolian-${stamp}.json`, JSON.stringify({ meta, cells, samples }, null, 2));
  console.log(`\nWrote reports/mongolian-${stamp}.json  (${cells.length} load cells, ${samples.length} full Mongolian outputs captured)`);
}
main().catch((e) => { console.error("\nFatal:", e); process.exit(1); });
