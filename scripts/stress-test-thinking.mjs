#!/usr/bin/env node
// vLLM decode/thinking stress test (companion to stress-test.mjs).
//
// Drives /v1/chat/completions with a VAST forced output window to stress the
// decode (generation) path, comparing thinking ON vs OFF. Caching is avoided
// (unique random prompt per request). Writes a JSON + Markdown report.
//
// Thinking is enabled via chat_template_kwargs:{enable_thinking:true} (verified
// on this server); reasoning tokens stream as delta.reasoning.
//
// NOTE: output length is FORCED (ignore_eos), so both modes generate the SAME
// token count — the think-vs-no-think delta here measures per-token overhead at
// equal work, not thinking's real-world tendency to emit more tokens.
//
// Usage:
//   node scripts/stress-test-thinking.mjs          # full run
//   QUICK=1 node scripts/stress-test-thinking.mjs  # tiny smoke
//
// Config via env (defaults mirror app/api/chat/route.ts):
//   VLLM_BASE_URL, VLLM_API_KEY, MODEL,
//   CONCURRENCIES="3,5,10,15", INPUT_SIZE=2000, OUTPUT_TOKENS=2048,
//   MODES="think,nothink", REQS_PER_CONC=3,
//   WARMUP=1, COOLDOWN_MS=3000, REQUEST_TIMEOUT_MS=300000

import { writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const QUICK = process.env.QUICK === "1";

const BASE_URL = (
  process.env.VLLM_BASE_URL ||
  "https://twiki-consumption-genuine-whats.trycloudflare.com/v1"
).replace(/\/+$/, "");
const ROOT = BASE_URL.replace(/\/v1$/, ""); // /tokenize lives at server root
const API_KEY =
  process.env.VLLM_API_KEY ||
  "a39e4fb12f8062efbb56dbb5be6fc8d3b58af30629afae586aaa8850c5ea8a0c";
const MODEL = process.env.MODEL || "gemma-4-31b";

const CONCURRENCIES = parseList(process.env.CONCURRENCIES, QUICK ? [3] : [3, 5, 10, 15]);
const INPUT_SIZE = num(process.env.INPUT_SIZE, 2000);
const OUTPUT_TOKENS = num(process.env.OUTPUT_TOKENS, QUICK ? 128 : 2048);
const MODES = (process.env.MODES || "think,nothink").split(",").map((s) => s.trim()).filter(Boolean);
const REQS_PER_CONC = num(process.env.REQS_PER_CONC, 3);
const reqsForConc = (c) => (QUICK ? 2 : REQS_PER_CONC * c);
const WARMUP = num(process.env.WARMUP, QUICK ? 0 : 1);
const COOLDOWN_MS = num(process.env.COOLDOWN_MS, QUICK ? 500 : 3000);
const REQUEST_TIMEOUT_MS = num(process.env.REQUEST_TIMEOUT_MS, 300000);

const AUTH = { Authorization: `Bearer ${API_KEY}` };
let serverFingerprint = null;

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
function randomWords(n) {
  const out = [];
  const az = "abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < n; i++) {
    const len = 3 + Math.floor(Math.random() * 6);
    let w = "";
    for (let j = 0; j < len; j++) w += az[Math.floor(Math.random() * 26)];
    out.push(w);
  }
  return out;
}
const enableThinking = (mode) => mode === "think";

// ---------------------------------------------------------------------------
// vLLM API
// ---------------------------------------------------------------------------
async function tokenize(text) {
  const res = await fetch(`${ROOT}/tokenize`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`tokenize HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  return (await res.json()).count;
}

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

async function findFillerWord() {
  for (const w of [" the", " and", " of", " to", " a", " word"]) {
    const base = await tokenize("calibration anchor text");
    const withFiller = await tokenize("calibration anchor text" + w.repeat(5));
    if (withFiller - base === 5) return w;
  }
  return " the";
}

// Build a unique chat prompt whose user-message content is ~target tokens.
// Uniqueness (random prefix) defeats prefix caching across all cells/modes.
async function buildChatPrompt(target, label, wordsPerToken, filler) {
  const nonce = `${label}-${randomBytes(8).toString("hex")} `;
  let words = randomWords(Math.max(4, Math.floor((target - 8) * wordsPerToken)));
  let text = nonce + words.join(" ");
  let count = await tokenize(text);
  let guard = 0;
  while (count > target && guard++ < 8) {
    const trim = Math.max(1, Math.ceil((count - target) * wordsPerToken));
    words = words.slice(0, Math.max(1, words.length - trim));
    text = nonce + words.join(" ");
    count = await tokenize(text);
  }
  guard = 0;
  while (count < target && guard++ < target) {
    text += filler.repeat(target - count);
    count = await tokenize(text);
  }
  guard = 0;
  while (count > target && guard++ < 16) {
    const i = text.lastIndexOf(filler);
    if (i < 0) break;
    text = text.slice(0, i);
    count = await tokenize(text);
  }
  return { messages: [{ role: "user", content: text }], contentTokens: count };
}

// One streamed chat completion. mode = "think" | "nothink".
async function doRequest(promptObj, mode) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  const tSend = performance.now();
  let tFirst = null;
  let tEnd = null;
  let usage = null;
  let reasoningChunks = 0;
  let contentChunks = 0;
  let finish = null;
  const body = {
    model: MODEL,
    messages: promptObj.messages,
    max_tokens: OUTPUT_TOKENS,
    min_tokens: OUTPUT_TOKENS,
    ignore_eos: true,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.6,
  };
  if (enableThinking(mode)) body.chat_template_kwargs = { enable_thinking: true };
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
      return { ok: false, status: res.status, error: b.slice(0, 200), mode };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          tEnd = performance.now();
          continue;
        }
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.system_fingerprint && !serverFingerprint) serverFingerprint = json.system_fingerprint;
        if (json.usage) usage = json.usage;
        const ch = json.choices?.[0];
        if (ch?.finish_reason) finish = ch.finish_reason;
        const reason = ch?.delta?.reasoning;
        const content = ch?.delta?.content;
        if (reason) {
          if (tFirst === null) tFirst = performance.now();
          reasoningChunks++;
        }
        if (content) {
          if (tFirst === null) tFirst = performance.now();
          contentChunks++;
        }
      }
    }
    clearTimeout(timer);
    if (tEnd === null) tEnd = performance.now();
    const ttft = tFirst !== null ? tFirst - tSend : null;
    const e2e = tEnd - tSend;
    const completion = usage?.completion_tokens ?? reasoningChunks + contentChunks;
    return {
      ok: true,
      status: 200,
      mode,
      ttft,
      e2e,
      decodeMs: tFirst !== null ? tEnd - tFirst : null,
      prompt_tokens: usage?.prompt_tokens ?? promptObj.contentTokens,
      completion_tokens: completion,
      reasoningChunks,
      contentChunks,
      finish,
    };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: e.name === "AbortError" ? "timeout" : String(e.message || e), mode };
  }
}

async function runPool(prompts, concurrency, mode, onTick) {
  const records = [];
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= prompts.length) return;
      const rec = await doRequest(prompts[i], mode);
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
function aggregate(mode, concurrency, records, cellDurationMs) {
  const ok = records.filter((r) => r.ok);
  const failed = records.filter((r) => !r.ok);
  const ttfts = ok.map((r) => r.ttft).filter((x) => x != null).sort((a, b) => a - b);
  const e2es = ok.map((r) => r.e2e).filter((x) => x != null).sort((a, b) => a - b);
  const tpots = ok
    .filter((r) => r.decodeMs != null && r.completion_tokens > 1)
    .map((r) => r.decodeMs / (r.completion_tokens - 1))
    .sort((a, b) => a - b);
  const decodeTps = ok
    .filter((r) => r.decodeMs != null && r.decodeMs > 0)
    .map((r) => r.completion_tokens / (r.decodeMs / 1000));
  const reasoningFrac = ok
    .map((r) => {
      const tot = r.reasoningChunks + r.contentChunks;
      return tot ? r.reasoningChunks / tot : 0;
    });
  const totalCompletion = ok.reduce((s, r) => s + (r.completion_tokens || 0), 0);
  const wallS = cellDurationMs / 1000;

  return {
    mode,
    concurrency,
    requested: records.length,
    succeeded: ok.length,
    failed: failed.length,
    successPct: records.length ? (ok.length / records.length) * 100 : 0,
    meanPromptTokens: mean(ok.map((r) => r.prompt_tokens)),
    meanCompletionTokens: mean(ok.map((r) => r.completion_tokens)),
    meanReasoningFrac: mean(reasoningFrac),
    ttft: { mean: mean(ttfts), p50: pct(ttfts, 50), p90: pct(ttfts, 90), p95: pct(ttfts, 95), p99: pct(ttfts, 99) },
    e2e: { mean: mean(e2es), p50: pct(e2es, 50), p95: pct(e2es, 95), p99: pct(e2es, 99) },
    tpot: { mean: mean(tpots), p50: pct(tpots, 50), p99: pct(tpots, 99) },
    decodeTpsPerReq: mean(decodeTps),
    aggOutputTps: wallS > 0 ? totalCompletion / wallS : null,
    achievedReqPerSec: wallS > 0 ? ok.length / wallS : null,
    cellDurationS: wallS,
    errorsSample: failed.slice(0, 5).map((f) => ({ status: f.status, error: f.error })),
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function renderMarkdown(meta, cells) {
  const L = [];
  const label = (m) => (m === "think" ? "Thinking ON" : "Thinking OFF");
  L.push(`# vLLM Decode / Thinking Stress-Test Report`);
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
  L.push(`| Input (per request) | ≈ ${meta.inputSize} tokens (unique random) |`);
  L.push(`| Output window (forced) | ${meta.outputTokens} tokens (\`ignore_eos\`) |`);
  L.push(`| Thinking | \`chat_template_kwargs:{enable_thinking:true}\` |`);
  L.push(`| Modes | ${meta.modes.map(label).join(" vs ")} |`);
  L.push(`| Reqs per cell | ${meta.reqsPerConc} × concurrency |`);
  L.push(`| Client | Node ${meta.node}, single machine |`);
  L.push("");
  L.push(`## Caveats`);
  L.push("");
  L.push(`- **Forced length:** both modes generate exactly ${meta.outputTokens} tokens (\`ignore_eos\`), so decode *work* is identical across modes. The ON-vs-OFF delta here reflects **per-token overhead at equal work**, NOT thinking's real-world tendency to emit *more* tokens (that needs a natural-length run).`);
  L.push(`- The endpoint is a **Cloudflare quick-tunnel**: TTFT/E2E include network RTT and possible buffering. Treat absolute latencies as client-observed.`);
  L.push(`- Load is from a **single client machine**.`);
  L.push(`- **Caching avoided:** unique random prompt per request, \`Cache-Control: no-cache\`, forced generation.`);
  L.push(`- Reasoning-fraction is approximated from streamed chunk counts (≈1 token/chunk).`);
  L.push("");

  for (const mode of meta.modes) {
    const rows = cells.filter((c) => c.mode === mode).sort((a, b) => a.concurrency - b.concurrency);
    if (!rows.length) continue;
    L.push(`## ${label(mode)}`);
    L.push("");
    L.push(`| Concurrency | Reqs | Success% | Prompt tok | Compl tok | Reasoning% | TTFT p50 (ms) | TTFT p95 (ms) | E2E p50 (s) | E2E p95 (s) | TPOT p50 (ms/tok) | Decode tok/s (per req) | Agg out tok/s | Req/s |`);
    L.push(`| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
    for (const c of rows) {
      L.push(
        `| ${c.concurrency} | ${c.succeeded}/${c.requested} | ${fmt(c.successPct, 0)}% | ${fmt(c.meanPromptTokens, 0)} | ${fmt(c.meanCompletionTokens, 0)} | ${fmt(c.meanReasoningFrac * 100, 0)}% | ${fmt(c.ttft.p50, 0)} | ${fmt(c.ttft.p95, 0)} | ${fmt(c.e2e.p50 / 1000, 2)} | ${fmt(c.e2e.p95 / 1000, 2)} | ${fmt(c.tpot.p50, 1)} | ${fmt(c.decodeTpsPerReq, 1)} | ${fmt(c.aggOutputTps, 1)} | ${fmt(c.achievedReqPerSec, 2)} |`
      );
    }
    L.push("");
  }

  const matrix = (title, getter, digits) => {
    L.push(`### ${title}`);
    L.push("");
    L.push(`| mode \\ concurrency | ${meta.concurrencies.join(" | ")} |`);
    L.push(`| :-- | ${meta.concurrencies.map(() => "---:").join(" | ")} |`);
    for (const mode of meta.modes) {
      const vals = meta.concurrencies.map((conc) => {
        const c = cells.find((x) => x.mode === mode && x.concurrency === conc);
        return c ? fmt(getter(c), digits) : "—";
      });
      L.push(`| ${label(mode)} | ${vals.join(" | ")} |`);
    }
    L.push("");
  };
  L.push(`## Comparison matrices`);
  L.push("");
  matrix("Aggregate output throughput (tok/s)", (c) => c.aggOutputTps, 1);
  matrix("Per-request decode tok/s (single-stream)", (c) => c.decodeTpsPerReq, 1);
  matrix("TTFT p95 (ms)", (c) => c.ttft.p95, 0);
  matrix("TPOT p50 (ms/token)", (c) => c.tpot.p50, 1);
  matrix("E2E p50 (s)", (c) => c.e2e.p50 / 1000, 2);

  // Observations: think vs nothink delta per concurrency.
  L.push(`## Observations`);
  L.push("");
  const obs = [];
  if (meta.modes.includes("think") && meta.modes.includes("nothink")) {
    for (const conc of meta.concurrencies) {
      const t = cells.find((c) => c.mode === "think" && c.concurrency === conc);
      const n = cells.find((c) => c.mode === "nothink" && c.concurrency === conc);
      if (!t || !n) continue;
      const dDecode = n.decodeTpsPerReq ? ((t.decodeTpsPerReq - n.decodeTpsPerReq) / n.decodeTpsPerReq) * 100 : null;
      const dThr = n.aggOutputTps ? ((t.aggOutputTps - n.aggOutputTps) / n.aggOutputTps) * 100 : null;
      obs.push(
        `- **c=${conc}:** decode/stream ${fmt(t.decodeTpsPerReq, 1)} (ON) vs ${fmt(n.decodeTpsPerReq, 1)} (OFF) tok/s → ${dDecode == null ? "—" : (dDecode >= 0 ? "+" : "") + fmt(dDecode, 1) + "%"}; aggregate ${fmt(t.aggOutputTps, 1)} vs ${fmt(n.aggOutputTps, 1)} tok/s → ${dThr == null ? "—" : (dThr >= 0 ? "+" : "") + fmt(dThr, 1) + "%"}. Thinking trace ≈ ${fmt(t.meanReasoningFrac * 100, 0)}% of output.`
      );
    }
  }
  // Peak throughput per mode.
  for (const mode of meta.modes) {
    const rows = cells.filter((c) => c.mode === mode);
    if (!rows.length) continue;
    let best = rows[0];
    for (const r of rows) if ((r.aggOutputTps ?? 0) > (best.aggOutputTps ?? 0)) best = r;
    obs.push(`- **${label(mode)} peak aggregate throughput:** ${fmt(best.aggOutputTps, 1)} tok/s at concurrency ${best.concurrency}.`);
  }
  const anyFail = cells.filter((c) => c.failed > 0);
  obs.push(anyFail.length
    ? `- ⚠️ **Errors:** ${anyFail.map((c) => `${c.failed} at (${label(c.mode)}, c=${c.concurrency})`).join("; ")}.`
    : `- ✅ No request failures across all cells.`);
  L.push(...obs);
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`vLLM decode/thinking stress test${QUICK ? " (QUICK smoke)" : ""}`);
  console.log(`  endpoint:    ${BASE_URL}/chat/completions`);
  console.log(`  model:       ${MODEL}`);
  console.log(`  input:       ≈${INPUT_SIZE} tokens   output: ${OUTPUT_TOKENS} (forced)`);
  console.log(`  modes:       ${MODES.join(", ")}`);
  console.log(`  concurrency: [${CONCURRENCIES.join(", ")}]   reqs/cell: ${QUICK ? 2 : `${REQS_PER_CONC} × c`}`);
  console.log("");

  const modelInfo = await fetchModelInfo();
  const maxModelLen = modelInfo?.max_model_len ?? null;
  if (maxModelLen && INPUT_SIZE + OUTPUT_TOKENS > maxModelLen) {
    console.log(`  ⚠️  input ${INPUT_SIZE} + output ${OUTPUT_TOKENS} = ${INPUT_SIZE + OUTPUT_TOKENS} > max_model_len ${maxModelLen}`);
  }

  console.log("Calibrating tokenizer...");
  const filler = await findFillerWord();
  const sample = randomWords(400);
  const wordsPerToken = sample.length / (await tokenize(sample.join(" ")));
  console.log(`  filler="${filler.trim()}"  words/token≈${wordsPerToken.toFixed(3)}`);

  // Pre-generate unique prompts per mode (disjoint across modes & warmup).
  const promptsByMode = {};
  const warmupByMode = {};
  for (const mode of MODES) {
    const total = CONCURRENCIES.reduce((s, c) => s + reqsForConc(c), 0);
    process.stdout.write(`Generating ${total} unique ${INPUT_SIZE}-token prompts for ${mode} `);
    const list = [];
    for (let i = 0; i < total; i++) {
      list.push(await buildChatPrompt(INPUT_SIZE, `${mode}-r${i}`, wordsPerToken, filler));
      if (i % 10 === 0) process.stdout.write(".");
    }
    const warm = [];
    for (let i = 0; i < WARMUP; i++) warm.push(await buildChatPrompt(INPUT_SIZE, `${mode}-warm${i}`, wordsPerToken, filler));
    promptsByMode[mode] = list;
    warmupByMode[mode] = warm;
    console.log(" done");
  }

  const cells = [];
  for (const mode of MODES) {
    const pool = promptsByMode[mode];
    let cursor = 0;
    if (warmupByMode[mode]?.length) await runPool(warmupByMode[mode], Math.min(WARMUP, 2), mode);
    for (const conc of CONCURRENCIES) {
      const n = reqsForConc(conc);
      const cellPrompts = pool.slice(cursor, cursor + n);
      cursor += n;
      process.stdout.write(`${mode} c=${conc} n=${n}  `);
      const start = performance.now();
      const records = await runPool(cellPrompts, conc, mode, (rec) => process.stdout.write(rec.ok ? "." : "x"));
      const dur = performance.now() - start;
      const agg = aggregate(mode, conc, records, dur);
      cells.push(agg);
      console.log(
        `  done ${fmt(dur / 1000, 1)}s  TTFTp50=${fmt(agg.ttft.p50, 0)}ms  E2Ep50=${fmt(agg.e2e.p50 / 1000, 1)}s  decode/req=${fmt(agg.decodeTpsPerReq, 1)}tok/s  out=${fmt(agg.aggOutputTps, 1)}tok/s  reason=${fmt(agg.meanReasoningFrac * 100, 0)}%  ok=${agg.succeeded}/${agg.requested}`
      );
      if (COOLDOWN_MS) await sleep(COOLDOWN_MS);
    }
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    model: MODEL,
    modelRoot: modelInfo?.root ?? null,
    maxModelLen,
    serverFingerprint,
    inputSize: INPUT_SIZE,
    outputTokens: OUTPUT_TOKENS,
    reqsPerConc: REQS_PER_CONC,
    concurrencies: CONCURRENCIES,
    modes: MODES,
    node: process.version,
    quick: QUICK,
  };

  mkdirSync("reports", { recursive: true });
  const stamp = ts();
  const jsonPath = `reports/thinking-${stamp}.json`;
  const mdPath = `reports/thinking-${stamp}.md`;
  writeFileSync(jsonPath, JSON.stringify({ meta, cells }, null, 2));
  writeFileSync(mdPath, renderMarkdown(meta, cells));
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

main().catch((e) => {
  console.error("\nFatal:", e);
  process.exit(1);
});
