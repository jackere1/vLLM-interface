#!/usr/bin/env node
// vLLM realistic-traffic load test (companion to stress-test.mjs).
//
// Simulates real app traffic: a large templated pool of short prompts — some
// weather questions (which trigger the get_weather tool round-trip), some
// off-topic — sampled with replacement under concurrency. Replicates the app's
// system prompt + tool schema and drives /v1/chat/completions directly.
//
// For weather prompts it does the realistic 2-turn round-trip: model emits a
// get_weather tool_call -> we inject a CANNED weather result -> model summarizes.
// (No real open-meteo call, so tool-execution latency is excluded by design.)
//
// Measures, per concurrency cell: tool-calling accuracy, TTFT/E2E latency,
// throughput, and the live vLLM prefix-cache hit-rate + peak KV usage / queue
// depth from /metrics (so we KNOW whether the pool beat the cache).
//
// Usage:
//   node scripts/stress-test-realistic.mjs         # full run
//   QUICK=1 node scripts/stress-test-realistic.mjs # tiny smoke
//
// Config via env: VLLM_BASE_URL, VLLM_API_KEY, MODEL, CONCURRENCIES="3,5,10,15",
//   REQS_PER_CONC=10, WEATHER_RATIO=0.5, MAX_TOKENS=512, TEMPERATURE=0.7,
//   WARMUP=3, COOLDOWN_MS=2000, REQUEST_TIMEOUT_MS=120000

import { writeFileSync, mkdirSync } from "node:fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const QUICK = process.env.QUICK === "1";
const BASE_URL = (
  process.env.VLLM_BASE_URL ||
  "https://twiki-consumption-genuine-whats.trycloudflare.com/v1"
).replace(/\/+$/, "");
const ROOT = BASE_URL.replace(/\/v1$/, "");
const API_KEY =
  process.env.VLLM_API_KEY ||
  "a39e4fb12f8062efbb56dbb5be6fc8d3b58af30629afae586aaa8850c5ea8a0c";
const MODEL = process.env.MODEL || "gemma-4-31b";

const CONCURRENCIES = parseList(process.env.CONCURRENCIES, QUICK ? [3] : [3, 5, 10, 15]);
const REQS_PER_CONC = num(process.env.REQS_PER_CONC, 10);
const reqsForConc = (c) => (QUICK ? 4 : REQS_PER_CONC * c);
const WEATHER_RATIO = num(process.env.WEATHER_RATIO, 0.5);
const MAX_TOKENS = num(process.env.MAX_TOKENS, 512);
const TEMPERATURE = num(process.env.TEMPERATURE, 0.7);
const WARMUP = num(process.env.WARMUP, QUICK ? 0 : 3);
const COOLDOWN_MS = num(process.env.COOLDOWN_MS, QUICK ? 500 : 2000);
const REQUEST_TIMEOUT_MS = num(process.env.REQUEST_TIMEOUT_MS, 120000);

const AUTH = { Authorization: `Bearer ${API_KEY}` };
let serverFingerprint = null;

// System prompt + tool schema mirror app/api/chat/route.ts.
const SYSTEM_PROMPT = `You are a friendly, concise weather assistant.

When the user asks about the weather in a place, ALWAYS call the get_weather tool to fetch real, current conditions — do not guess. After you receive the tool result, summarise it in plain English in one or two sentences: temperature, what it feels like, and the overall condition. Mention wind or precipitation only if notable.

For non-weather questions, answer briefly and helpfully.`;
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description:
        "Get the current real-world weather for a city or location. Returns temperature in Celsius, feels-like, humidity, wind, precipitation, and a textual condition.",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description:
              'City name, optionally with country/region. Examples: "Tokyo", "Paris, France", "Austin, Texas".',
          },
        },
        required: ["location"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseList(v, dflt) {
  if (!v) return dflt;
  return v.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
}
function num(v, dflt) {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}
function pct(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}
function fmt(n, digits = 1) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function ts() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function strhash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Corpus (large templated pool, generated locally — no network)
// ---------------------------------------------------------------------------
const CITIES = [
  "Tokyo", "Paris", "London", "New York", "Berlin", "Madrid", "Rome", "Lisbon", "Vienna", "Prague",
  "Amsterdam", "Brussels", "Copenhagen", "Oslo", "Stockholm", "Helsinki", "Dublin", "Warsaw", "Budapest", "Athens",
  "Istanbul", "Moscow", "Kyiv", "Bucharest", "Zurich", "Geneva", "Munich", "Hamburg", "Milan", "Naples",
  "Barcelona", "Seville", "Porto", "Glasgow", "Manchester", "Birmingham", "Edinburgh", "Cardiff", "Reykjavik", "Tallinn",
  "Riga", "Vilnius", "Sofia", "Belgrade", "Zagreb", "Ljubljana", "Bratislava", "Krakow", "Gdansk", "Cologne",
  "Beijing", "Shanghai", "Shenzhen", "Guangzhou", "Hong Kong", "Taipei", "Seoul", "Busan", "Osaka", "Kyoto",
  "Nagoya", "Sapporo", "Bangkok", "Hanoi", "Ho Chi Minh City", "Manila", "Jakarta", "Kuala Lumpur", "Singapore", "Mumbai",
  "Delhi", "Bangalore", "Chennai", "Kolkata", "Hyderabad", "Karachi", "Lahore", "Dhaka", "Colombo", "Kathmandu",
  "Dubai", "Abu Dhabi", "Doha", "Riyadh", "Jeddah", "Tehran", "Baghdad", "Amman", "Beirut", "Tel Aviv",
  "Cairo", "Casablanca", "Marrakech", "Tunis", "Lagos", "Nairobi", "Accra", "Addis Ababa", "Cape Town", "Johannesburg",
  "Toronto", "Vancouver", "Montreal", "Ottawa", "Calgary", "Chicago", "Los Angeles", "San Francisco", "Seattle", "Boston",
  "Austin", "Denver", "Miami", "Houston", "Dallas", "Atlanta", "Phoenix", "Portland", "Mexico City", "Guadalajara",
  "Bogota", "Lima", "Santiago", "Buenos Aires", "Sao Paulo", "Rio de Janeiro", "Quito", "Caracas", "Montevideo", "Brasilia",
  "Sydney", "Melbourne", "Brisbane", "Perth", "Auckland", "Wellington", "Honolulu", "Anchorage", "Reno", "Boise",
];
const WEATHER_TEMPLATES = [
  (c) => `What's the weather in ${c} right now?`,
  (c) => `How's the weather in ${c} today?`,
  (c) => `Is it raining in ${c} at the moment?`,
  (c) => `What's the temperature in ${c}?`,
  (c) => `Will I need a jacket in ${c} right now?`,
  (c) => `Give me the current conditions in ${c}.`,
  (c) => `Is it cold in ${c} today?`,
  (c) => `Should I bring an umbrella in ${c}?`,
];
const TOPICS = [
  "coffee", "rain", "mountains", "the ocean", "autumn", "cats", "old books", "city nights", "the moon", "trains",
  "gardens", "thunderstorms", "deserts", "snow", "rivers", "lighthouses", "fireflies", "vinyl records", "tea", "bicycles",
  "robots", "volcanoes", "honeybees", "the aurora", "tidepools", "campfires", "skyscrapers", "origami", "jazz", "kites",
];
const CONCEPTS = [
  "gravity", "inflation", "photosynthesis", "compound interest", "machine learning", "the water cycle", "tectonic plates",
  "supply and demand", "DNA", "black holes", "encryption", "evolution", "vaccines", "the stock market", "quantum entanglement",
  "the greenhouse effect", "blockchain", "neural networks", "antibiotics", "magnetism", "recursion", "entropy", "tides", "GDP", "osmosis",
];
const DISHES = [
  "a quick weeknight pasta", "a vegetarian stir-fry", "a hearty soup", "a 10-minute breakfast", "a chicken curry",
  "a simple salad", "fish tacos", "a lentil stew", "homemade pizza", "fried rice", "a smoothie bowl", "shakshuka",
  "a grain bowl", "miso ramen", "a bean chili", "stuffed peppers", "a frittata", "pad thai", "dumplings", "a burrito",
];
const STYLES = ["short", "playful", "vivid", "minimalist", "whimsical"];
const AUDIENCES = ["a 10-year-old", "a beginner", "a busy adult", "a curious teenager"];
function buildCorpus() {
  const weather = [];
  const seen = new Set();
  for (const c of CITIES) {
    for (const t of WEATHER_TEMPLATES) {
      const text = t(c);
      if (!seen.has(text)) { seen.add(text); weather.push({ type: "weather", text, city: c }); }
    }
  }
  const offtopic = [];
  const oseen = new Set();
  const push = (text) => { if (!oseen.has(text)) { oseen.add(text); offtopic.push({ type: "offtopic", text }); } };
  for (const t of TOPICS) for (const s of STYLES) push(`Write a ${s} one-line haiku about ${t}.`);
  for (const c of CONCEPTS) for (const a of AUDIENCES) push(`Explain ${c} to ${a} in one sentence.`);
  for (const t of TOPICS) for (const s of STYLES) push(`Suggest a ${s} name for a ${t}-themed cafe.`);
  for (const t of TOPICS) push(`Share one surprising fact about ${t}.`);
  for (const c of CONCEPTS) push(`What's a common misconception about ${c}?`);
  for (const d of DISHES) push(`Give me a quick recipe idea: ${d}.`);
  for (const d of DISHES) push(`What's one tip to improve ${d}?`);
  return { weather, offtopic };
}

// Canned weather result, shaped like the app's WeatherToolOutput; varied per city.
function cannedWeather(location) {
  const h = strhash(location);
  const conditions = ["Clear sky", "Partly cloudy", "Overcast", "Light rain", "Moderate rain", "Light snow", "Fog", "Mainly clear"];
  const temp = -5 + (h % 38);
  return {
    location,
    timezone: "auto",
    temperature_c: temp,
    feels_like_c: temp - (h % 4),
    humidity_pct: 35 + (h % 60),
    wind_kmh: h % 35,
    wind_direction_deg: h % 360,
    precipitation_mm: (h % 5) === 0 ? (h % 12) / 10 : 0,
    is_day: (h % 2) === 0,
    weather_code: h % 100,
    condition: conditions[h % conditions.length],
  };
}

// ---------------------------------------------------------------------------
// vLLM API
// ---------------------------------------------------------------------------
async function fetchModelInfo() {
  try {
    const res = await fetch(`${BASE_URL}/models`, { headers: AUTH });
    if (!res.ok) return null;
    const j = await res.json();
    return j.data?.find((m) => m.id === MODEL) || j.data?.[0] || null;
  } catch {
    return null;
  }
}

function metricVal(text, name) {
  const re = new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{[^}]*\\}\\s+([-0-9.eE+]+)", "m");
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}
async function sampleMetrics() {
  try {
    const res = await fetch(`${ROOT}/metrics`, { headers: AUTH });
    if (!res.ok) return null;
    const t = await res.text();
    return {
      queries: metricVal(t, "vllm:prefix_cache_queries_total"),
      hits: metricVal(t, "vllm:prefix_cache_hits_total"),
      kv: metricVal(t, "vllm:kv_cache_usage_perc"),
      running: metricVal(t, "vllm:num_requests_running"),
      waiting: metricVal(t, "vllm:num_requests_waiting"),
    };
  } catch {
    return null;
  }
}

// Stream one chat completion. Returns timing + accumulated content + tool calls.
async function streamChat(messages, withTools) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  const t0 = performance.now();
  let tFirst = null, tEnd = null, usage = null, finish = null, content = "";
  const toolAcc = {};
  const body = {
    model: MODEL,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
  };
  if (withTools) {
    body.tools = TOOLS;
    body.tool_choice = "auto";
  }
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json", "Cache-Control": "no-cache" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const b = await res.text().catch(() => "");
      clearTimeout(timer);
      return { ok: false, status: res.status, error: b.slice(0, 200) };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { tEnd = performance.now(); continue; }
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.system_fingerprint && !serverFingerprint) serverFingerprint = j.system_fingerprint;
        if (j.usage) usage = j.usage;
        const ch = j.choices?.[0];
        if (!ch) continue;
        if (ch.finish_reason) finish = ch.finish_reason;
        const d = ch.delta || {};
        if (d.content) { if (tFirst === null) tFirst = performance.now(); content += d.content; }
        if (d.tool_calls) {
          if (tFirst === null) tFirst = performance.now();
          for (const tc of d.tool_calls) {
            const idx = tc.index ?? 0;
            toolAcc[idx] = toolAcc[idx] || { id: null, name: null, args: "" };
            if (tc.id) toolAcc[idx].id = tc.id;
            if (tc.function?.name) toolAcc[idx].name = tc.function.name;
            if (tc.function?.arguments) toolAcc[idx].args += tc.function.arguments;
          }
        }
      }
    }
    clearTimeout(timer);
    if (tEnd === null) tEnd = performance.now();
    return {
      ok: true,
      status: 200,
      ttft: tFirst !== null ? tFirst - t0 : null,
      latency: tEnd - t0,
      content,
      toolCalls: Object.values(toolAcc),
      usage,
      finish,
    };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: e.name === "AbortError" ? "timeout" : String(e.message || e) };
  }
}

// One realistic request: turn 1 (+ optional tool round-trip turn 2).
async function doRequest(prompt) {
  const t0 = performance.now();
  const sys = { role: "system", content: SYSTEM_PROMPT };
  const user = { role: "user", content: prompt.text };
  const r1 = await streamChat([sys, user], true);
  if (!r1.ok) return { ok: false, type: prompt.type, ...r1 };

  const toolCalled = r1.toolCalls.length > 0;
  let r2 = null;
  let loc = null, injected = null, toolName = null, toolArgsRaw = null;
  if (toolCalled) {
    const tc = r1.toolCalls[0];
    toolName = tc.name || "get_weather";
    toolArgsRaw = tc.args || "";
    loc = prompt.city || "the area";
    try { loc = JSON.parse(tc.args).location || loc; } catch {}
    const canned = cannedWeather(loc);
    injected = { temperature_c: canned.temperature_c, condition: canned.condition };
    const assistant = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: tc.id || "call_0", type: "function", function: { name: toolName, arguments: toolArgsRaw || "{}" } }],
    };
    const toolResult = { role: "tool", tool_call_id: tc.id || "call_0", content: JSON.stringify(canned) };
    r2 = await streamChat([sys, user, assistant, toolResult], false); // summary turn, no tools
  }
  const tEnd = performance.now();
  const out = (r1.usage?.completion_tokens || 0) + (r2?.usage?.completion_tokens || 0);
  const decodeMs = (r1.latency - (r1.ttft || 0)) + (r2 ? r2.latency - (r2.ttft || 0) : 0);
  return {
    ok: true,
    type: prompt.type,
    toolCalled,
    turns: r2 ? 2 : 1,
    ttft: r1.ttft,
    e2e: tEnd - t0,
    outputTokens: out,
    promptTokens: r1.usage?.prompt_tokens || null,
    decodeTps: decodeMs > 0 ? out / (decodeMs / 1000) : null,
    finish1: r1.finish,
    finish2: r2?.finish ?? null,
    // audit fields (sampled into the report JSON for accuracy checking)
    promptText: prompt.text,
    toolName,
    toolLocation: loc,
    toolArgsRaw,
    injected,
    answer: ((r2?.content ?? r1.content) || "").trim().slice(0, 400),
  };
}

async function runPool(prompts, concurrency, onTick) {
  const records = [];
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= prompts.length) return;
      const rec = await doRequest(prompts[i]);
      records.push(rec);
      if (onTick) onTick(rec);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, prompts.length) }, worker));
  return records;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------
function aggregate(concurrency, records, cellDurationMs, cache, peak, uniquePromptsPct) {
  const ok = records.filter((r) => r.ok);
  const failed = records.filter((r) => !r.ok);
  const weather = ok.filter((r) => r.type === "weather");
  const offtopic = ok.filter((r) => r.type === "offtopic");
  const ttfts = ok.map((r) => r.ttft).filter((x) => x != null).sort((a, b) => a - b);
  const e2es = ok.map((r) => r.e2e).filter((x) => x != null).sort((a, b) => a - b);
  const totalOut = ok.reduce((s, r) => s + (r.outputTokens || 0), 0);
  const wallS = cellDurationMs / 1000;
  const hitRate = cache && cache.dq > 0 ? (cache.dh / cache.dq) * 100 : null;
  // Audit samples (saved to JSON so accuracy can be eyeballed): a few per type.
  const byType = {};
  for (const r of ok) (byType[r.type] = byType[r.type] || []).push(r);
  const samples = Object.values(byType).flatMap((arr) =>
    arr.slice(0, 10).map((r) => ({
      type: r.type,
      toolCalled: r.toolCalled,
      location: r.toolLocation,
      injected: r.injected,
      prompt: (r.promptText || "").slice(0, 300),
      answer: r.answer,
    }))
  );
  return {
    concurrency,
    requested: records.length,
    succeeded: ok.length,
    failed: failed.length,
    successPct: records.length ? (ok.length / records.length) * 100 : 0,
    nWeather: weather.length,
    nOfftopic: offtopic.length,
    weatherToolRatePct: weather.length ? (weather.filter((r) => r.toolCalled).length / weather.length) * 100 : null,
    offtopicFalseToolPct: offtopic.length ? (offtopic.filter((r) => r.toolCalled).length / offtopic.length) * 100 : null,
    meanOutputTokens: mean(ok.map((r) => r.outputTokens)),
    ttft: { mean: mean(ttfts), p50: pct(ttfts, 50), p95: pct(ttfts, 95), p99: pct(ttfts, 99) },
    e2e: {
      mean: mean(e2es), p50: pct(e2es, 50), p95: pct(e2es, 95), p99: pct(e2es, 99),
      weatherP50: pct(weather.map((r) => r.e2e).sort((a, b) => a - b), 50),
      offtopicP50: pct(offtopic.map((r) => r.e2e).sort((a, b) => a - b), 50),
    },
    decodeTpsPerReq: mean(ok.map((r) => r.decodeTps).filter((x) => x != null)),
    aggOutputTps: wallS > 0 ? totalOut / wallS : null,
    achievedReqPerSec: wallS > 0 ? ok.length / wallS : null,
    cellDurationS: wallS,
    prefixCacheHitPct: hitRate,
    uniquePromptsPct,
    cacheQueries: cache?.dq ?? null,
    peakKvUsagePct: peak ? peak.kv * 100 : null,
    peakRunning: peak?.running ?? null,
    peakWaiting: peak?.waiting ?? null,
    samples,
    errorsSample: failed.slice(0, 5).map((f) => ({ status: f.status, error: f.error })),
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function renderMarkdown(meta, cells) {
  const L = [];
  L.push(`# vLLM Realistic-Traffic Load-Test Report`);
  L.push("");
  L.push(`**Generated:** ${meta.generatedAt}`);
  L.push("");
  L.push(`## Environment`);
  L.push("");
  L.push(`| Field | Value |`);
  L.push(`| --- | --- |`);
  L.push(`| Endpoint | \`${meta.baseUrl}/chat/completions\` |`);
  L.push(`| Model | \`${meta.model}\`${meta.modelRoot ? ` (root \`${meta.modelRoot}\`)` : ""} |`);
  L.push(`| max_model_len | ${meta.maxModelLen ?? "?"} |`);
  L.push(`| vLLM | ${meta.serverFingerprint || "?"} |`);
  L.push(`| KV cache capacity | ${meta.kvBlocks ?? "?"} blocks × ${meta.blockSize ?? "?"} = ~${meta.kvCapacityTokens ? meta.kvCapacityTokens.toLocaleString("en-US") : "?"} tokens |`);
  L.push(`| Prompt pool | ${meta.poolWeather} weather + ${meta.poolOfftopic} off-topic = ${meta.poolWeather + meta.poolOfftopic} distinct |`);
  L.push(`| Weather:off-topic mix | ${fmt(meta.weatherRatio * 100, 0)}% / ${fmt((1 - meta.weatherRatio) * 100, 0)}% |`);
  L.push(`| Output | natural EOS, cap ${meta.maxTokens}, temp ${meta.temperature} |`);
  L.push(`| Reqs per cell | ${meta.reqsPerConc} × concurrency |`);
  L.push(`| Client | Node ${meta.node}, single machine |`);
  L.push("");
  L.push(`## Caveats`);
  L.push("");
  L.push(`- **Realistic shape:** short prompts, natural-length answers. Prefill is cheap regardless of caching, so this primarily measures **throughput/latency under concurrency** for real multi-turn tool traffic, plus tool-calling accuracy.`);
  L.push(`- **Tool round-trip:** weather prompts do model→tool_call→**canned** result→summary (2 generation turns). Real open-meteo latency is excluded by design.`);
  L.push(`- **Cache:** prompts are sampled with replacement from a large pool. **Unique prompts%** = distinct prompts ÷ requests in that cell (high = little replay, so we're not re-serving cached completions). The **prefix-cache hit%** is block-level and stays high because the shared system prompt + tool schema (sent on *every* request) is always cached — that residual is unavoidable and realistic; what matters is the user-content diversity captured by Unique prompts%.`);
  L.push(`- The endpoint is a **Cloudflare quick-tunnel**: latencies are client-observed and include network RTT.`);
  L.push("");
  L.push(`## Per-concurrency results`);
  L.push("");
  L.push(`| Concurrency | Reqs | Success% | Weather tool-call% | Off-topic false-call% | Mean out tok | TTFT p50 (ms) | TTFT p95 (ms) | E2E p50 (s) | E2E p95 (s) | Agg out tok/s | Req/s | Unique prompts% | Prefix-cache hit% | Peak KV% | Peak waiting |`);
  L.push(`| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const c of cells.sort((a, b) => a.concurrency - b.concurrency)) {
    L.push(
      `| ${c.concurrency} | ${c.succeeded}/${c.requested} | ${fmt(c.successPct, 0)}% | ${fmt(c.weatherToolRatePct, 0)}% | ${fmt(c.offtopicFalseToolPct, 0)}% | ${fmt(c.meanOutputTokens, 0)} | ${fmt(c.ttft.p50, 0)} | ${fmt(c.ttft.p95, 0)} | ${fmt(c.e2e.p50 / 1000, 2)} | ${fmt(c.e2e.p95 / 1000, 2)} | ${fmt(c.aggOutputTps, 1)} | ${fmt(c.achievedReqPerSec, 2)} | ${fmt(c.uniquePromptsPct, 0)}% | ${fmt(c.prefixCacheHitPct, 1)}% | ${fmt(c.peakKvUsagePct, 1)}% | ${fmt(c.peakWaiting, 0)} |`
    );
  }
  L.push("");
  L.push(`### Latency by request type (E2E p50, s)`);
  L.push("");
  L.push(`| Concurrency | Weather (2-turn) | Off-topic (1-turn) |`);
  L.push(`| ---: | ---: | ---: |`);
  for (const c of cells.sort((a, b) => a.concurrency - b.concurrency)) {
    L.push(`| ${c.concurrency} | ${fmt(c.e2e.weatherP50 / 1000, 2)} | ${fmt(c.e2e.offtopicP50 / 1000, 2)} |`);
  }
  L.push("");
  L.push(`## Observations`);
  L.push("");
  const obs = [];
  const rows = cells.sort((a, b) => a.concurrency - b.concurrency);
  const toolAcc = mean(rows.map((c) => c.weatherToolRatePct).filter((x) => x != null));
  const falseAcc = mean(rows.map((c) => c.offtopicFalseToolPct).filter((x) => x != null));
  obs.push(`- **Tool-calling accuracy:** weather prompts triggered get_weather ${fmt(toolAcc, 1)}% of the time; off-topic prompts wrongly called it ${fmt(falseAcc, 1)}% of the time.`);
  const hitRates = rows.map((c) => c.prefixCacheHitPct).filter((x) => x != null);
  const uniq = mean(rows.map((c) => c.uniquePromptsPct).filter((x) => x != null));
  if (hitRates.length) {
    obs.push(`- **Cache:** ${fmt(uniq, 0)}% of sampled prompts were unique (little replay) — we're not re-serving cached completions. Block-level prefix-cache hit% sat at ${fmt(Math.min(...hitRates), 1)}%–${fmt(Math.max(...hitRates), 1)}%, dominated by the always-shared system prompt + tool schema (realistic and unavoidable), not by full-prompt replay. For short prompts prefill is cheap regardless, so the GPU stress here is decode + concurrency.`);
  }
  let best = rows[0];
  for (const r of rows) if ((r.achievedReqPerSec ?? 0) > (best.achievedReqPerSec ?? 0)) best = r;
  obs.push(`- **Throughput:** peak ${fmt(best.achievedReqPerSec, 2)} req/s at concurrency ${best.concurrency}; E2E p95 grew from ${fmt(rows[0].e2e.p95 / 1000, 2)}s (c=${rows[0].concurrency}) to ${fmt(rows[rows.length - 1].e2e.p95 / 1000, 2)}s (c=${rows[rows.length - 1].concurrency}).`);
  const saturated = rows.filter((c) => (c.peakWaiting ?? 0) > 0);
  if (saturated.length) obs.push(`- **Saturation:** requests queued (num_requests_waiting>0) at concurrency ${saturated.map((c) => c.concurrency).join(", ")} — peak KV usage up to ${fmt(Math.max(...rows.map((c) => c.peakKvUsagePct ?? 0)), 1)}%.`);
  const anyFail = cells.filter((c) => c.failed > 0);
  obs.push(anyFail.length ? `- ⚠️ **Errors:** ${anyFail.map((c) => `${c.failed} at c=${c.concurrency}`).join("; ")}.` : `- ✅ No request failures across all cells.`);
  L.push(...obs);
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`vLLM realistic-traffic load test${QUICK ? " (QUICK smoke)" : ""}`);
  console.log(`  endpoint:    ${BASE_URL}/chat/completions`);
  console.log(`  model:       ${MODEL}`);
  console.log(`  mix:         ${fmt(WEATHER_RATIO * 100, 0)}% weather / ${fmt((1 - WEATHER_RATIO) * 100, 0)}% off-topic`);
  console.log(`  output:      natural EOS (cap ${MAX_TOKENS}, temp ${TEMPERATURE})`);
  console.log(`  concurrency: [${CONCURRENCIES.join(", ")}]   reqs/cell: ${QUICK ? 4 : `${REQS_PER_CONC} × c`}`);
  console.log("");

  const modelInfo = await fetchModelInfo();
  const { weather, offtopic } = buildCorpus();
  console.log(`Corpus: ${weather.length} weather + ${offtopic.length} off-topic = ${weather.length + offtopic.length} distinct prompts`);

  // KV capacity from /metrics cache_config_info (best-effort).
  let kvBlocks = null, blockSize = null;
  const mtext = await fetch(`${ROOT}/metrics`, { headers: AUTH }).then((r) => (r.ok ? r.text() : "")).catch(() => "");
  const cfg = mtext.match(/vllm:cache_config_info\{([^}]*)\}/);
  if (cfg) {
    const nb = cfg[1].match(/num_gpu_blocks="(\d+)"/);
    const bs = cfg[1].match(/block_size="(\d+)"/);
    kvBlocks = nb ? Number(nb[1]) : null;
    blockSize = bs ? Number(bs[1]) : null;
  }
  const kvCapacityTokens = kvBlocks && blockSize ? kvBlocks * blockSize : null;

  const sampleReq = () => {
    const useWeather = Math.random() < WEATHER_RATIO;
    return useWeather && weather.length ? pick(weather) : pick(offtopic.length ? offtopic : weather);
  };

  // Warmup (untimed).
  if (WARMUP > 0) {
    await runPool(Array.from({ length: WARMUP }, sampleReq), Math.min(WARMUP, 3));
  }

  const cells = [];
  for (const conc of CONCURRENCIES) {
    const n = reqsForConc(conc);
    const prompts = Array.from({ length: n }, sampleReq);
    const uniquePromptsPct = (new Set(prompts.map((p) => p.text)).size / n) * 100;

    const before = await sampleMetrics();
    const peak = { kv: 0, running: 0, waiting: 0 };
    let polling = true;
    const poller = (async () => {
      while (polling) {
        const m = await sampleMetrics();
        if (m) {
          peak.kv = Math.max(peak.kv, m.kv ?? 0);
          peak.running = Math.max(peak.running, m.running ?? 0);
          peak.waiting = Math.max(peak.waiting, m.waiting ?? 0);
        }
        await sleep(700);
      }
    })();

    process.stdout.write(`c=${conc} n=${n}  `);
    const start = performance.now();
    const records = await runPool(prompts, conc, (rec) => process.stdout.write(rec.ok ? (rec.type === "weather" ? "w" : ".") : "x"));
    const dur = performance.now() - start;
    polling = false;
    await poller;
    const after = await sampleMetrics();

    const cache = before && after ? { dq: after.queries - before.queries, dh: after.hits - before.hits } : null;
    const agg = aggregate(conc, records, dur, cache, peak, uniquePromptsPct);
    cells.push(agg);
    console.log(
      `  done ${fmt(dur / 1000, 1)}s  TTFTp50=${fmt(agg.ttft.p50, 0)}ms  E2Ep50=${fmt(agg.e2e.p50 / 1000, 2)}s  req/s=${fmt(agg.achievedReqPerSec, 2)}  toolAcc=${fmt(agg.weatherToolRatePct, 0)}%  cacheHit=${fmt(agg.prefixCacheHitPct, 1)}%  peakKV=${fmt(agg.peakKvUsagePct, 1)}%  ok=${agg.succeeded}/${agg.requested}`
    );
    if (COOLDOWN_MS) await sleep(COOLDOWN_MS);
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    model: MODEL,
    modelRoot: modelInfo?.root ?? null,
    maxModelLen: modelInfo?.max_model_len ?? null,
    serverFingerprint,
    kvBlocks,
    blockSize,
    kvCapacityTokens,
    poolWeather: weather.length,
    poolOfftopic: offtopic.length,
    weatherRatio: WEATHER_RATIO,
    maxTokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    reqsPerConc: REQS_PER_CONC,
    concurrencies: CONCURRENCIES,
    node: process.version,
    quick: QUICK,
  };

  mkdirSync("reports", { recursive: true });
  const stamp = ts();
  const jsonPath = `reports/realistic-${stamp}.json`;
  const mdPath = `reports/realistic-${stamp}.md`;
  writeFileSync(jsonPath, JSON.stringify({ meta, cells }, null, 2));
  writeFileSync(mdPath, renderMarkdown(meta, cells));
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

main().catch((e) => {
  console.error("\nFatal:", e);
  process.exit(1);
});
