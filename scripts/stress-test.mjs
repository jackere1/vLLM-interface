#!/usr/bin/env node
// vLLM GPU stress-test harness.
//
// Drives the vLLM /v1/completions endpoint directly across a matrix of
// concurrency x input-token sizes, with caching avoided (unique random prompt
// per request), and writes a JSON + Markdown report.
//
// Usage:
//   node scripts/stress-test.mjs            # full run
//   QUICK=1 node scripts/stress-test.mjs    # tiny smoke matrix
//
// Config via env (defaults mirror app/api/chat/route.ts):
//   VLLM_BASE_URL, VLLM_API_KEY, MODEL,
//   CONCURRENCIES="3,5,10,15", INPUT_SIZES="2000,4000,8000",
//   OUTPUT_TOKENS=128, REQS_PER_CONC=5  (reqs per cell = REQS_PER_CONC * concurrency)
//   WARMUP=2, COOLDOWN_MS=2000, REQUEST_TIMEOUT_MS=120000

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
// /tokenize lives at the server root, not under /v1.
const ROOT = BASE_URL.replace(/\/v1$/, "");
const API_KEY =
  process.env.VLLM_API_KEY ||
  "a39e4fb12f8062efbb56dbb5be6fc8d3b58af30629afae586aaa8850c5ea8a0c";
const MODEL = process.env.MODEL || "gemma-4-31b";

const CONCURRENCIES = parseList(process.env.CONCURRENCIES, QUICK ? [3] : [3, 5, 10, 15]);
const INPUT_SIZES = parseList(process.env.INPUT_SIZES, QUICK ? [2000] : [2000, 4000, 8000]);
const OUTPUT_TOKENS = num(process.env.OUTPUT_TOKENS, 128);
const REQS_PER_CONC = num(process.env.REQS_PER_CONC, 5);
const reqsForConc = (c) => (QUICK ? 3 : REQS_PER_CONC * c);
const WARMUP = num(process.env.WARMUP, QUICK ? 1 : 2);
const COOLDOWN_MS = num(process.env.COOLDOWN_MS, QUICK ? 500 : 2000);
const REQUEST_TIMEOUT_MS = num(process.env.REQUEST_TIMEOUT_MS, 120000);

const AUTH = { Authorization: `Bearer ${API_KEY}` };
let serverFingerprint = null; // captured from a streamed usage chunk

// ---------------------------------------------------------------------------
// Small helpers
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
    const len = 3 + Math.floor(Math.random() * 6); // 3..8
    let w = "";
    for (let j = 0; j < len; j++) w += az[Math.floor(Math.random() * 26)];
    out.push(w);
  }
  return out;
}

// ---------------------------------------------------------------------------
// vLLM API
// ---------------------------------------------------------------------------
async function tokenize(text) {
  // Use the server's default add_special_tokens so this count matches the
  // prompt_tokens the /v1/completions endpoint reports back.
  const res = await fetch(`${ROOT}/tokenize`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`tokenize HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  const j = await res.json();
  return j.count;
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

// Determine a filler word that adds exactly 1 token, for exact-length padding.
async function findFillerWord() {
  for (const w of [" the", " and", " of", " to", " a", " word"]) {
    const base = await tokenize("calibration anchor text");
    const withFiller = await tokenize("calibration anchor text" + w.repeat(5));
    if (withFiller - base === 5) return w;
  }
  return " the"; // fallback; padding loop self-corrects regardless
}

// Build a unique prompt of exactly `target` tokens.
// Uniqueness (random prefix) defeats vLLM prefix caching; repeated filler only
// appears at the END, after the prompt has already diverged, so no cache reuse.
async function buildPrompt(target, label, wordsPerToken, filler) {
  const nonce = `${label}-${randomBytes(8).toString("hex")} `;
  // Undershoot the target a little, then pad up to exact.
  let words = randomWords(Math.max(4, Math.floor((target - 8) * wordsPerToken)));
  let text = nonce + words.join(" ");
  let count = await tokenize(text);

  // Coarse correction if we overshot badly.
  let guard = 0;
  while (count > target && guard++ < 8) {
    const trim = Math.max(1, Math.ceil((count - target) * wordsPerToken));
    words = words.slice(0, Math.max(1, words.length - trim));
    text = nonce + words.join(" ");
    count = await tokenize(text);
  }
  // Pad up to exact with single-token filler.
  guard = 0;
  while (count < target && guard++ < target) {
    const add = target - count;
    text += filler.repeat(add);
    count = await tokenize(text);
  }
  // Boundary merges may overshoot by a couple tokens; trim filler one at a time.
  guard = 0;
  while (count > target && guard++ < 16) {
    const i = text.lastIndexOf(filler);
    if (i < 0) break;
    text = text.slice(0, i);
    count = await tokenize(text);
  }
  return { prompt: text, tokens: count };
}

// One streamed completion request. Returns a metric record.
async function doRequest(promptObj) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  const tSend = performance.now();
  let tFirst = null;
  let tEnd = null;
  let usage = null;
  let chunks = 0;
  try {
    const res = await fetch(`${BASE_URL}/completions`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json", "Cache-Control": "no-cache" },
      body: JSON.stringify({
        model: MODEL,
        prompt: promptObj.prompt,
        max_tokens: OUTPUT_TOKENS,
        min_tokens: OUTPUT_TOKENS,
        ignore_eos: true,
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0,
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      clearTimeout(timer);
      return { ok: false, status: res.status, error: body.slice(0, 200) };
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
        const text = json.choices?.[0]?.text;
        if (text) {
          if (tFirst === null) tFirst = performance.now();
          chunks++;
        }
      }
    }
    clearTimeout(timer);
    if (tEnd === null) tEnd = performance.now();
    const ttft = tFirst !== null ? tFirst - tSend : null;
    const e2e = tEnd - tSend;
    const completion = usage?.completion_tokens ?? chunks;
    const prompt_tokens = usage?.prompt_tokens ?? promptObj.tokens;
    const decodeMs = tFirst !== null ? tEnd - tFirst : null;
    return { ok: true, status: 200, ttft, e2e, decodeMs, prompt_tokens, completion_tokens: completion };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: e.name === "AbortError" ? "timeout" : String(e.message || e) };
  }
}

// Run `n` requests through a pool of `concurrency` workers.
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
function aggregate(inputSize, concurrency, records, cellDurationMs) {
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

  const totalCompletion = ok.reduce((s, r) => s + (r.completion_tokens || 0), 0);
  const totalPrompt = ok.reduce((s, r) => s + (r.prompt_tokens || 0), 0);
  const wallS = cellDurationMs / 1000;

  return {
    inputSize,
    concurrency,
    requested: records.length,
    succeeded: ok.length,
    failed: failed.length,
    successPct: records.length ? (ok.length / records.length) * 100 : 0,
    meanPromptTokens: mean(ok.map((r) => r.prompt_tokens)),
    meanCompletionTokens: mean(ok.map((r) => r.completion_tokens)),
    ttft: {
      mean: mean(ttfts), p50: pct(ttfts, 50), p90: pct(ttfts, 90),
      p95: pct(ttfts, 95), p99: pct(ttfts, 99), min: ttfts[0] ?? null, max: ttfts[ttfts.length - 1] ?? null,
    },
    e2e: { mean: mean(e2es), p50: pct(e2es, 50), p95: pct(e2es, 95), p99: pct(e2es, 99) },
    tpot: { mean: mean(tpots), p50: pct(tpots, 50), p99: pct(tpots, 99) },
    decodeTpsPerReq: mean(decodeTps),
    aggOutputTps: wallS > 0 ? totalCompletion / wallS : null,
    aggPrefillTps: wallS > 0 ? totalPrompt / wallS : null,
    aggTotalTps: wallS > 0 ? (totalCompletion + totalPrompt) / wallS : null,
    achievedReqPerSec: wallS > 0 ? ok.length / wallS : null,
    cellDurationS: wallS,
    errorsSample: failed.slice(0, 5).map((f) => ({ status: f.status, error: f.error })),
  };
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------
function renderMarkdown(meta, cells) {
  const L = [];
  L.push(`# vLLM GPU Stress-Test Report`);
  L.push("");
  L.push(`**Generated:** ${meta.generatedAt}`);
  L.push("");
  L.push(`## Environment`);
  L.push("");
  L.push(`| Field | Value |`);
  L.push(`| --- | --- |`);
  L.push(`| Endpoint | \`${meta.baseUrl}\` |`);
  L.push(`| Model | \`${meta.model}\`${meta.modelRoot ? ` (root \`${meta.modelRoot}\`)` : ""} |`);
  L.push(`| max_model_len | ${meta.maxModelLen ?? "?"} |`);
  L.push(`| vLLM | ${meta.serverFingerprint || "?"} |`);
  L.push(`| Output tokens (forced) | ${meta.outputTokens} (ignore_eos) |`);
  L.push(`| Reqs per cell | ${meta.reqsPerConc} × concurrency |`);
  L.push(`| Client | Node ${meta.node}, single machine |`);
  L.push("");
  L.push(`## Caveats`);
  L.push("");
  L.push(`- The endpoint is a **Cloudflare quick-tunnel**: TTFT/E2E include tunnel network RTT, and the tunnel may buffer or throttle at high concurrency. Treat absolute latencies as client-observed, not server-internal.`);
  L.push(`- Load comes from a **single client machine**; the client itself can become a bottleneck at high concurrency.`);
  L.push(`- \`max_model_len\` is **${meta.maxModelLen ?? "8192"}**, so the largest input cell + ${meta.outputTokens} output runs near the context ceiling.`);
  L.push(`- **Caching avoided:** every request uses a unique random prompt (unique prefix defeats vLLM prefix caching), \`Cache-Control: no-cache\`, and forced generation (\`ignore_eos\`).`);
  L.push("");

  // Per-input-size detail tables.
  for (const size of meta.inputSizes) {
    const rows = cells.filter((c) => c.inputSize === size).sort((a, b) => a.concurrency - b.concurrency);
    if (!rows.length) continue;
    L.push(`## Input ≈ ${size} tokens`);
    L.push("");
    L.push(`| Concurrency | Reqs | Success% | TTFT p50 (ms) | TTFT p95 (ms) | E2E p50 (s) | E2E p95 (s) | TPOT p50 (ms/tok) | Decode tok/s (per req) | Agg out tok/s | Req/s |`);
    L.push(`| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
    for (const c of rows) {
      L.push(
        `| ${c.concurrency} | ${c.succeeded}/${c.requested} | ${fmt(c.successPct, 0)}% | ${fmt(c.ttft.p50, 0)} | ${fmt(c.ttft.p95, 0)} | ${fmt(c.e2e.p50 / 1000, 2)} | ${fmt(c.e2e.p95 / 1000, 2)} | ${fmt(c.tpot.p50, 1)} | ${fmt(c.decodeTpsPerReq, 1)} | ${fmt(c.aggOutputTps, 1)} | ${fmt(c.achievedReqPerSec, 2)} |`
      );
    }
    L.push("");
  }

  // Matrices.
  const matrix = (title, getter, digits) => {
    L.push(`### ${title}`);
    L.push("");
    L.push(`| input \\ concurrency | ${meta.concurrencies.join(" | ")} |`);
    L.push(`| ---: | ${meta.concurrencies.map(() => "---:").join(" | ")} |`);
    for (const size of meta.inputSizes) {
      const vals = meta.concurrencies.map((conc) => {
        const c = cells.find((x) => x.inputSize === size && x.concurrency === conc);
        return c ? fmt(getter(c), digits) : "—";
      });
      L.push(`| ${size} | ${vals.join(" | ")} |`);
    }
    L.push("");
  };
  L.push(`## Throughput & latency matrices`);
  L.push("");
  matrix("Aggregate output throughput (tok/s)", (c) => c.aggOutputTps, 1);
  matrix("E2E latency p95 (s)", (c) => c.e2e.p95 / 1000, 2);
  matrix("TTFT p95 (ms)", (c) => c.ttft.p95, 0);

  // Observations.
  L.push(`## Observations`);
  L.push("");
  const obs = [];
  for (const size of meta.inputSizes) {
    const rows = cells.filter((c) => c.inputSize === size).sort((a, b) => a.concurrency - b.concurrency);
    if (rows.length < 2) continue;
    let best = rows[0];
    for (const r of rows) if ((r.aggOutputTps ?? 0) > (best.aggOutputTps ?? 0)) best = r;
    obs.push(`- **${size}-token input:** peak aggregate output throughput ${fmt(best.aggOutputTps, 1)} tok/s at concurrency ${best.concurrency}. TTFT p95 grew from ${fmt(rows[0].ttft.p95, 0)} ms (c=${rows[0].concurrency}) to ${fmt(rows[rows.length - 1].ttft.p95, 0)} ms (c=${rows[rows.length - 1].concurrency}).`);
  }
  const anyFail = cells.filter((c) => c.failed > 0);
  if (anyFail.length) {
    obs.push(`- ⚠️ **Errors:** ${anyFail.map((c) => `${c.failed} at (size ${c.inputSize}, c=${c.concurrency})`).join("; ")}. See JSON for samples.`);
  } else {
    obs.push(`- ✅ No request failures across all cells.`);
  }
  L.push(...obs);
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`vLLM stress test${QUICK ? " (QUICK smoke mode)" : ""}`);
  console.log(`  endpoint:     ${BASE_URL}`);
  console.log(`  model:        ${MODEL}`);
  console.log(`  concurrency:  [${CONCURRENCIES.join(", ")}]`);
  console.log(`  input sizes:  [${INPUT_SIZES.join(", ")}]`);
  console.log(`  output:       ${OUTPUT_TOKENS} tokens (forced, ignore_eos)`);
  console.log(`  reqs/cell:    ${QUICK ? 3 : `${REQS_PER_CONC} × concurrency`}`);
  console.log("");

  const modelInfo = await fetchModelInfo();
  const maxModelLen = modelInfo?.max_model_len ?? null;
  const modelRoot = modelInfo?.root ?? null;
  if (maxModelLen) {
    for (const size of INPUT_SIZES) {
      if (size + OUTPUT_TOKENS > maxModelLen) {
        console.log(`  ⚠️  input ${size} + output ${OUTPUT_TOKENS} = ${size + OUTPUT_TOKENS} > max_model_len ${maxModelLen}`);
      }
    }
  }

  // Calibrate prompt building.
  console.log("Calibrating tokenizer...");
  const filler = await findFillerWord();
  const sampleWords = randomWords(400);
  const sampleTokens = await tokenize(sampleWords.join(" "));
  const wordsPerToken = sampleWords.length / sampleTokens; // ~words needed per token
  console.log(`  filler="${filler.trim()}"  words/token≈${wordsPerToken.toFixed(3)}`);

  // Pre-generate all unique prompts per size (untimed). Cell prompts and warmup
  // prompts are disjoint, so warmup never primes a prefix the timed cells reuse.
  const promptsBySize = {};
  const warmupBySize = {};
  for (const size of INPUT_SIZES) {
    const total = CONCURRENCIES.reduce((s, c) => s + reqsForConc(c), 0);
    process.stdout.write(`Generating ${total} unique ${size}-token prompts `);
    const list = [];
    for (let i = 0; i < total; i++) {
      list.push(await buildPrompt(size, `s${size}-r${i}`, wordsPerToken, filler));
      if (i % 10 === 0) process.stdout.write(".");
    }
    const warm = [];
    for (let i = 0; i < WARMUP; i++) {
      warm.push(await buildPrompt(size, `s${size}-warm${i}`, wordsPerToken, filler));
    }
    promptsBySize[size] = list;
    warmupBySize[size] = warm;
    const got = list.map((p) => p.tokens);
    console.log(` done (tokens ${Math.min(...got)}–${Math.max(...got)}, mean ${fmt(mean(got), 0)})`);
  }

  // Run the matrix: outer = input size, inner = concurrency.
  const cells = [];
  for (const size of INPUT_SIZES) {
    const pool = promptsBySize[size].slice();
    let cursor = 0;

    // Warmup (untimed, not recorded) on disjoint prompts to spin up the size.
    if (warmupBySize[size]?.length) {
      await runPool(warmupBySize[size], Math.min(WARMUP, 2));
    }

    for (const conc of CONCURRENCIES) {
      const n = reqsForConc(conc);
      // Take n fresh, never-before-sent prompts for this cell.
      let cellPrompts = pool.slice(cursor, cursor + n);
      cursor += n;
      if (cellPrompts.length < n) {
        // Shouldn't happen (we generated `total`), but guard anyway.
        cellPrompts = pool.slice(0, n);
      }

      process.stdout.write(`size=${size} c=${conc} n=${n}  `);
      const start = performance.now();
      const records = await runPool(cellPrompts, conc, (rec) =>
        process.stdout.write(rec.ok ? "." : "x")
      );
      const dur = performance.now() - start;
      const agg = aggregate(size, conc, records, dur);
      cells.push(agg);
      console.log(
        `  done ${fmt(dur / 1000, 1)}s  TTFTp50=${fmt(agg.ttft.p50, 0)}ms  E2Ep50=${fmt(agg.e2e.p50 / 1000, 2)}s  out=${fmt(agg.aggOutputTps, 1)}tok/s  ok=${agg.succeeded}/${agg.requested}`
      );
      if (COOLDOWN_MS) await sleep(COOLDOWN_MS);
    }
  }

  // Assemble metadata + write reports.
  const meta = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    model: MODEL,
    modelRoot,
    maxModelLen,
    serverFingerprint,
    outputTokens: OUTPUT_TOKENS,
    reqsPerConc: REQS_PER_CONC,
    concurrencies: CONCURRENCIES,
    inputSizes: INPUT_SIZES,
    node: process.version,
    quick: QUICK,
  };

  mkdirSync("reports", { recursive: true });
  const stamp = ts();
  const jsonPath = `reports/stress-${stamp}.json`;
  const mdPath = `reports/stress-${stamp}.md`;
  writeFileSync(jsonPath, JSON.stringify({ meta, cells }, null, 2));
  writeFileSync(mdPath, renderMarkdown(meta, cells));

  console.log("");
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

main().catch((e) => {
  console.error("\nFatal:", e);
  process.exit(1);
});
