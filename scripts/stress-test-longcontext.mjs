#!/usr/bin/env node
// vLLM long-context / summarization stress test.
//
// Builds coherent documents (1K/2K/4K tokens) from REAL technical docs
// (Context7-sourced, see longctx-corpus.mjs) and drives two agentic tasks:
//   - summarize: "Summarize the following documentation ..."
//   - longctx:   "<doc> ... Based on the above, <complex question>"
// over /v1/chat/completions, sweeping concurrency. Measures TTFT/E2E,
// throughput, prefix-cache hit-rate + peak KV from /metrics, broken down by
// document size and task. Saves answer samples so quality can be eyeballed.
//
// Usage:
//   node scripts/stress-test-longcontext.mjs          # full run
//   QUICK=1 node scripts/stress-test-longcontext.mjs  # tiny smoke
//
// Config via env: VLLM_BASE_URL, VLLM_API_KEY, MODEL, CONCURRENCIES="5,10,20,40",
//   REQS_PER_CONC=4, DOC_SIZES="1000,2000,4000", MAX_TOKENS=768, TEMPERATURE=0.4,
//   WARMUP=2, COOLDOWN_MS=2500, REQUEST_TIMEOUT_MS=180000

import { writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { CHUNKS, SUMMARIZE_TEMPLATES, COMPLEX_QUESTIONS } from "./longctx-corpus.mjs";

const QUICK = process.env.QUICK === "1";
const BASE_URL = (process.env.VLLM_BASE_URL || "https://twiki-consumption-genuine-whats.trycloudflare.com/v1").replace(/\/+$/, "");
const ROOT = BASE_URL.replace(/\/v1$/, "");
const API_KEY = process.env.VLLM_API_KEY || "a39e4fb12f8062efbb56dbb5be6fc8d3b58af30629afae586aaa8850c5ea8a0c";
const MODEL = process.env.MODEL || "gemma-4-31b";

const CONCURRENCIES = parseList(process.env.CONCURRENCIES, QUICK ? [3] : [5, 10, 20, 40]);
const REQS_PER_CONC = num(process.env.REQS_PER_CONC, 4);
const reqsForConc = (c) => (QUICK ? 3 : REQS_PER_CONC * c);
const DOC_SIZES = parseList(process.env.DOC_SIZES, QUICK ? [1000] : [1000, 2000, 4000]);
const MAX_TOKENS = num(process.env.MAX_TOKENS, QUICK ? 128 : 768);
const TEMPERATURE = num(process.env.TEMPERATURE, 0.4);
const WARMUP = num(process.env.WARMUP, QUICK ? 0 : 2);
const COOLDOWN_MS = num(process.env.COOLDOWN_MS, QUICK ? 500 : 2500);
const REQUEST_TIMEOUT_MS = num(process.env.REQUEST_TIMEOUT_MS, 180000);

const AUTH = { Authorization: `Bearer ${API_KEY}` };
let serverFingerprint = null;

// ---------------- helpers ----------------
function parseList(v, dflt) { if (!v) return dflt; return v.split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite); }
function num(v, dflt) { const n = v == null ? NaN : Number(v); return Number.isFinite(n) ? n : dflt; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function pct(s, p) { if (!s.length) return null; return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]; }
function fmt(n, d = 1) { if (n == null || Number.isNaN(n)) return "—"; return Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); }
function ts() { const d = new Date(); const p = (x) => String(x).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function shuffle(a) { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; }

// ---------------- vLLM API ----------------
async function tokenize(text) {
  const res = await fetch(`${ROOT}/tokenize`, { method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, prompt: text }) });
  if (!res.ok) throw new Error(`tokenize HTTP ${res.status}`);
  return (await res.json()).count;
}
async function fetchModelInfo() {
  try { const res = await fetch(`${BASE_URL}/models`, { headers: AUTH }); if (!res.ok) return null; const j = await res.json(); return j.data?.find((m) => m.id === MODEL) || j.data?.[0] || null; } catch { return null; }
}
function metricVal(text, name) {
  const re = new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{[^}]*\\}\\s+([-0-9.eE+]+)", "m");
  const m = text.match(re); return m ? Number(m[1]) : null;
}
async function sampleMetrics() {
  try {
    const res = await fetch(`${ROOT}/metrics`, { headers: AUTH }); if (!res.ok) return null;
    const t = await res.text();
    return { queries: metricVal(t, "vllm:prefix_cache_queries_total"), hits: metricVal(t, "vllm:prefix_cache_hits_total"), kv: metricVal(t, "vllm:kv_cache_usage_perc"), running: metricVal(t, "vllm:num_requests_running"), waiting: metricVal(t, "vllm:num_requests_waiting") };
  } catch { return null; }
}

// ---------------- document assembly ----------------
let chunkTokens = []; // filled at startup
function assembleDoc(targetTokens, label) {
  const order = shuffle(CHUNKS.map((_, i) => i));
  const parts = [];
  let toks = 12; // ~ title line
  let i = 0;
  while (toks < targetTokens && i < 80) {
    const idx = order[i % order.length];
    parts.push(`## ${CHUNKS[idx].title}\n${CHUNKS[idx].text}`);
    toks += chunkTokens[idx];
    i++;
  }
  // Unique label defeats prefix caching even when chunk bodies overlap.
  return { doc: `[doc:${label}]\n\n${parts.join("\n\n")}`, approxTokens: toks };
}

// ---------------- one request ----------------
async function doRequest(reqSpec) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  const t0 = performance.now();
  let tFirst = null, tEnd = null, usage = null, finish = null, content = "";
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: "You are a precise, helpful technical assistant. Answer using only the provided documentation." },
      { role: "user", content: reqSpec.prompt },
    ],
    stream: true, stream_options: { include_usage: true }, temperature: TEMPERATURE, max_tokens: MAX_TOKENS,
  };
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, { method: "POST", headers: { ...AUTH, "Content-Type": "application/json", "Cache-Control": "no-cache" }, body: JSON.stringify(body), signal: ac.signal });
    if (!res.ok) { const b = await res.text().catch(() => ""); clearTimeout(timer); return { ok: false, status: res.status, error: b.slice(0, 200), task: reqSpec.task, sizeBucket: reqSpec.sizeBucket }; }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { tEnd = performance.now(); continue; }
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.system_fingerprint && !serverFingerprint) serverFingerprint = j.system_fingerprint;
        if (j.usage) usage = j.usage;
        const ch = j.choices?.[0]; if (!ch) continue;
        if (ch.finish_reason) finish = ch.finish_reason;
        const c = ch.delta?.content;
        if (c) { if (tFirst === null) tFirst = performance.now(); content += c; }
      }
    }
    clearTimeout(timer); if (tEnd === null) tEnd = performance.now();
    const out = usage?.completion_tokens || 0;
    const decodeMs = tFirst !== null ? tEnd - tFirst : null;
    return {
      ok: true, status: 200, task: reqSpec.task, sizeBucket: reqSpec.sizeBucket,
      ttft: tFirst !== null ? tFirst - t0 : null, e2e: tEnd - t0,
      outputTokens: out, promptTokens: usage?.prompt_tokens || null,
      decodeTps: decodeMs > 0 ? out / (decodeMs / 1000) : null, finish,
      instruction: reqSpec.instruction, answer: content.trim().slice(0, 400),
    };
  } catch (e) { clearTimeout(timer); return { ok: false, status: 0, error: e.name === "AbortError" ? "timeout" : String(e.message || e), task: reqSpec.task, sizeBucket: reqSpec.sizeBucket }; }
}

async function runPool(specs, concurrency, onTick) {
  const records = []; let idx = 0;
  async function worker() { while (true) { const i = idx++; if (i >= specs.length) return; const rec = await doRequest(specs[i]); records.push(rec); if (onTick) onTick(rec); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, specs.length) }, worker));
  return records;
}

// Build a request spec: task + doc-size bucket + assembled prompt.
function buildSpec(i) {
  const task = i % 2 === 0 ? "summarize" : "longctx";
  const sizeBucket = DOC_SIZES[Math.floor(i / 2) % DOC_SIZES.length];
  const label = `${task}-${sizeBucket}-${randomBytes(5).toString("hex")}`;
  const { doc } = assembleDoc(sizeBucket, label);
  const instruction = task === "summarize" ? pick(SUMMARIZE_TEMPLATES) : pick(COMPLEX_QUESTIONS);
  const prompt = task === "summarize" ? `${instruction}\n\n${doc}` : `${doc}\n\n${instruction}`;
  return { task, sizeBucket, prompt, instruction };
}

// ---------------- aggregation ----------------
function sub(records) {
  const e2e = records.map((r) => r.e2e).filter((x) => x != null).sort((a, b) => a - b);
  return { n: records.length, e2eP50: pct(e2e, 50), e2eP95: pct(e2e, 95), meanOut: mean(records.map((r) => r.outputTokens)), meanPrompt: mean(records.map((r) => r.promptTokens)), decodeTps: mean(records.map((r) => r.decodeTps).filter((x) => x != null)) };
}
function aggregate(concurrency, records, dur, cache, peak) {
  const ok = records.filter((r) => r.ok); const failed = records.filter((r) => !r.ok);
  const ttfts = ok.map((r) => r.ttft).filter((x) => x != null).sort((a, b) => a - b);
  const e2es = ok.map((r) => r.e2e).filter((x) => x != null).sort((a, b) => a - b);
  const totalOut = ok.reduce((s, r) => s + (r.outputTokens || 0), 0);
  const wallS = dur / 1000;
  const byBucket = {}; for (const b of DOC_SIZES) byBucket[b] = sub(ok.filter((r) => r.sizeBucket === b));
  const byTask = { summarize: sub(ok.filter((r) => r.task === "summarize")), longctx: sub(ok.filter((r) => r.task === "longctx")) };
  const samples = [];
  for (const b of DOC_SIZES) for (const tk of ["summarize", "longctx"]) {
    const s = ok.find((r) => r.sizeBucket === b && r.task === tk);
    if (s) samples.push({ task: s.task, sizeBucket: b, promptTokens: s.promptTokens, outputTokens: s.outputTokens, instruction: s.instruction, answer: s.answer });
  }
  return {
    concurrency, requested: records.length, succeeded: ok.length, failed: failed.length,
    successPct: records.length ? (ok.length / records.length) * 100 : 0,
    meanPromptTokens: mean(ok.map((r) => r.promptTokens)), meanOutputTokens: mean(ok.map((r) => r.outputTokens)),
    ttft: { mean: mean(ttfts), p50: pct(ttfts, 50), p95: pct(ttfts, 95) },
    e2e: { mean: mean(e2es), p50: pct(e2es, 50), p95: pct(e2es, 95), p99: pct(e2es, 99) },
    decodeTpsPerReq: mean(ok.map((r) => r.decodeTps).filter((x) => x != null)),
    aggOutputTps: wallS > 0 ? totalOut / wallS : null, achievedReqPerSec: wallS > 0 ? ok.length / wallS : null,
    cellDurationS: wallS, prefixCacheHitPct: cache && cache.dq > 0 ? (cache.dh / cache.dq) * 100 : null,
    peakKvUsagePct: peak ? peak.kv * 100 : null, peakRunning: peak?.running ?? null, peakWaiting: peak?.waiting ?? null,
    byBucket, byTask, samples, errorsSample: failed.slice(0, 5).map((f) => ({ status: f.status, error: f.error })),
  };
}

// ---------------- report ----------------
function renderMarkdown(meta, cells) {
  const L = [];
  L.push(`# vLLM Long-Context / Summarization Stress-Test Report`, "", `**Generated:** ${meta.generatedAt}`, "");
  L.push(`## Environment`, "");
  L.push(`| Field | Value |`, `| --- | --- |`);
  L.push(`| Endpoint | \`${meta.baseUrl}/chat/completions\` |`);
  L.push(`| Model | \`${meta.model}\`${meta.modelRoot ? ` (root \`${meta.modelRoot}\`)` : ""} |`);
  L.push(`| max_model_len | ${meta.maxModelLen ?? "?"} |`);
  L.push(`| vLLM | ${meta.serverFingerprint || "?"} |`);
  L.push(`| KV cache capacity | ~${meta.kvCapacityTokens ? meta.kvCapacityTokens.toLocaleString("en-US") : "?"} tokens |`);
  L.push(`| Documents | real Context7 docs (Next.js / vLLM / React / AI SDK), sizes ${meta.docSizes.join(" / ")} tokens |`);
  L.push(`| Tasks | summarization + long-context reasoning (50/50) |`);
  L.push(`| Output | natural EOS, cap ${meta.maxTokens}, temp ${meta.temperature} |`);
  L.push(`| Reqs per cell | ${meta.reqsPerConc} × concurrency |`);
  L.push(`| Client | Node ${meta.node}, single machine |`, "");
  L.push(`## Caveats`, "");
  L.push(`- **Heavy workload:** long real-document inputs (1–4K tokens) + substantial generated answers. Stresses both prefill and decode — the most demanding agentic shape.`);
  L.push(`- Each document has a unique id and shuffled section order, so prompts are distinct (low prefix-cache reuse beyond the shared system prompt).`);
  L.push(`- Cloudflare quick-tunnel: latencies are client-observed.`, "");
  L.push(`## Per-concurrency results`, "");
  L.push(`| Concurrency | Reqs | Success% | Mean in tok | Mean out tok | TTFT p50 (ms) | TTFT p95 (ms) | E2E p50 (s) | E2E p95 (s) | Decode tok/s (per req) | Agg out tok/s | Req/s | Prefix-cache hit% | Peak KV% | Peak waiting |`);
  L.push(`| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const c of cells.sort((a, b) => a.concurrency - b.concurrency)) {
    L.push(`| ${c.concurrency} | ${c.succeeded}/${c.requested} | ${fmt(c.successPct, 0)}% | ${fmt(c.meanPromptTokens, 0)} | ${fmt(c.meanOutputTokens, 0)} | ${fmt(c.ttft.p50, 0)} | ${fmt(c.ttft.p95, 0)} | ${fmt(c.e2e.p50 / 1000, 2)} | ${fmt(c.e2e.p95 / 1000, 2)} | ${fmt(c.decodeTpsPerReq, 1)} | ${fmt(c.aggOutputTps, 1)} | ${fmt(c.achievedReqPerSec, 2)} | ${fmt(c.prefixCacheHitPct, 1)}% | ${fmt(c.peakKvUsagePct, 1)}% | ${fmt(c.peakWaiting, 0)} |`);
  }
  L.push("");
  L.push(`### E2E p50 by document size (s)`, "");
  L.push(`| Concurrency | ${meta.docSizes.map((d) => `${d} tok`).join(" | ")} |`);
  L.push(`| ---: | ${meta.docSizes.map(() => "---:").join(" | ")} |`);
  for (const c of cells.sort((a, b) => a.concurrency - b.concurrency)) {
    L.push(`| ${c.concurrency} | ${meta.docSizes.map((d) => fmt((c.byBucket[d]?.e2eP50 ?? null) / 1000, 2)).join(" | ")} |`);
  }
  L.push("");
  L.push(`### E2E p50 by task (s)`, "");
  L.push(`| Concurrency | Summarize | Long-context reasoning |`, `| ---: | ---: | ---: |`);
  for (const c of cells.sort((a, b) => a.concurrency - b.concurrency)) {
    L.push(`| ${c.concurrency} | ${fmt((c.byTask.summarize?.e2eP50 ?? null) / 1000, 2)} | ${fmt((c.byTask.longctx?.e2eP50 ?? null) / 1000, 2)} |`);
  }
  L.push("");
  L.push(`## Observations`, "");
  const rows = cells.sort((a, b) => a.concurrency - b.concurrency);
  const obs = [];
  let best = rows[0]; for (const r of rows) if ((r.aggOutputTps ?? 0) > (best.aggOutputTps ?? 0)) best = r;
  obs.push(`- **Throughput:** peak ${fmt(best.aggOutputTps, 1)} output tok/s at concurrency ${best.concurrency}; req/s rose ${fmt(rows[0].achievedReqPerSec, 2)} → ${fmt(rows[rows.length - 1].achievedReqPerSec, 2)} (c=${rows[0].concurrency}→${rows[rows.length - 1].concurrency}).`);
  obs.push(`- **Latency:** E2E p95 grew ${fmt(rows[0].e2e.p95 / 1000, 2)}s → ${fmt(rows[rows.length - 1].e2e.p95 / 1000, 2)}s; TTFT p95 ${fmt(rows[0].ttft.p95, 0)} → ${fmt(rows[rows.length - 1].ttft.p95, 0)} ms.`);
  const maxKv = Math.max(...rows.map((c) => c.peakKvUsagePct ?? 0));
  const sat = rows.filter((c) => (c.peakWaiting ?? 0) > 0);
  obs.push(`- **KV pressure:** peak KV usage reached ${fmt(maxKv, 1)}%${sat.length ? `; requests queued (waiting>0) at concurrency ${sat.map((c) => c.concurrency).join(", ")} — heavy long-context saturates KV far sooner than short chat.` : " with no queuing — headroom remained."}`);
  const anyFail = cells.filter((c) => c.failed > 0);
  obs.push(anyFail.length ? `- ⚠️ **Errors:** ${anyFail.map((c) => `${c.failed} at c=${c.concurrency}`).join("; ")}.` : `- ✅ No request failures across all cells.`);
  L.push(...obs, "");
  return L.join("\n");
}

// ---------------- main ----------------
async function main() {
  console.log(`vLLM long-context / summarization stress test${QUICK ? " (QUICK smoke)" : ""}`);
  console.log(`  endpoint:    ${BASE_URL}/chat/completions`);
  console.log(`  doc sizes:   ${DOC_SIZES.join(", ")} tokens   output cap: ${MAX_TOKENS}`);
  console.log(`  concurrency: [${CONCURRENCIES.join(", ")}]   reqs/cell: ${QUICK ? 3 : `${REQS_PER_CONC} × c`}`);
  console.log("");

  const modelInfo = await fetchModelInfo();
  const mtext = await fetch(`${ROOT}/metrics`, { headers: AUTH }).then((r) => (r.ok ? r.text() : "")).catch(() => "");
  const cfg = mtext.match(/vllm:cache_config_info\{([^}]*)\}/);
  let kvBlocks = null, blockSize = null;
  if (cfg) { kvBlocks = Number((cfg[1].match(/num_gpu_blocks="(\d+)"/) || [])[1]) || null; blockSize = Number((cfg[1].match(/block_size="(\d+)"/) || [])[1]) || null; }
  const kvCapacityTokens = kvBlocks && blockSize ? kvBlocks * blockSize : null;

  console.log("Tokenizing corpus chunks...");
  chunkTokens = [];
  for (const c of CHUNKS) chunkTokens.push(await tokenize(`## ${c.title}\n${c.text}`));
  console.log(`  ${CHUNKS.length} chunks, ${chunkTokens.reduce((a, b) => a + b, 0)} tokens total (mean ${fmt(mean(chunkTokens), 0)}/chunk)`);

  if (WARMUP > 0) await runPool(Array.from({ length: WARMUP }, (_, i) => buildSpec(i)), Math.min(WARMUP, 2));

  const cells = [];
  for (const conc of CONCURRENCIES) {
    const n = reqsForConc(conc);
    const specs = Array.from({ length: n }, (_, i) => buildSpec(i));
    const before = await sampleMetrics();
    const peak = { kv: 0, running: 0, waiting: 0 };
    let polling = true;
    const poller = (async () => { while (polling) { const m = await sampleMetrics(); if (m) { peak.kv = Math.max(peak.kv, m.kv ?? 0); peak.running = Math.max(peak.running, m.running ?? 0); peak.waiting = Math.max(peak.waiting, m.waiting ?? 0); } await sleep(700); } })();
    process.stdout.write(`c=${conc} n=${n}  `);
    const start = performance.now();
    const records = await runPool(specs, conc, (rec) => process.stdout.write(rec.ok ? (rec.task === "summarize" ? "s" : "q") : "x"));
    const dur = performance.now() - start;
    polling = false; await poller;
    const after = await sampleMetrics();
    const cache = before && after ? { dq: after.queries - before.queries, dh: after.hits - before.hits } : null;
    const agg = aggregate(conc, records, dur, cache, peak);
    cells.push(agg);
    console.log(`  done ${fmt(dur / 1000, 1)}s  in=${fmt(agg.meanPromptTokens, 0)}tok out=${fmt(agg.meanOutputTokens, 0)}tok  TTFTp50=${fmt(agg.ttft.p50, 0)}ms  E2Ep50=${fmt(agg.e2e.p50 / 1000, 2)}s  out=${fmt(agg.aggOutputTps, 1)}tok/s  peakKV=${fmt(agg.peakKvUsagePct, 1)}%  wait=${fmt(agg.peakWaiting, 0)}  ok=${agg.succeeded}/${agg.requested}`);
    if (COOLDOWN_MS) await sleep(COOLDOWN_MS);
  }

  const meta = {
    generatedAt: new Date().toISOString(), baseUrl: BASE_URL, model: MODEL, modelRoot: modelInfo?.root ?? null,
    maxModelLen: modelInfo?.max_model_len ?? null, serverFingerprint, kvBlocks, blockSize, kvCapacityTokens,
    docSizes: DOC_SIZES, maxTokens: MAX_TOKENS, temperature: TEMPERATURE, reqsPerConc: REQS_PER_CONC,
    concurrencies: CONCURRENCIES, node: process.version, quick: QUICK,
  };
  mkdirSync("reports", { recursive: true });
  const stamp = ts();
  writeFileSync(`reports/longcontext-${stamp}.json`, JSON.stringify({ meta, cells }, null, 2));
  writeFileSync(`reports/longcontext-${stamp}.md`, renderMarkdown(meta, cells));
  console.log(`\nWrote reports/longcontext-${stamp}.json`);
  console.log(`Wrote reports/longcontext-${stamp}.md`);
}

main().catch((e) => { console.error("\nFatal:", e); process.exit(1); });
