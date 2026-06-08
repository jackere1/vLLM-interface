export const meta = {
  name: 'grade-vllm-outputs',
  description: 'Strict LLM-as-judge + adversarial verification of vLLM English & Mongolian outputs',
  phases: [
    { title: 'Grade', detail: 'one strict judge per captured sample' },
    { title: 'Verify', detail: 'one adversarial refuter per sample' },
  ],
}

// baseDir = absolute path to reports/grading. Per-sample files live at
// <baseDir>/<set>/<id>.json and are self-describing. Falls back to the known
// project path if args.baseDir is not wired through.
const baseDir = (typeof args !== 'undefined' && args && args.baseDir) || '/home/enkhbold/temp-pls/nextjs-vllm-demo/reports/grading'

function range(prefix, a, b, task, lang, set) {
  const r = []
  for (let i = a; i <= b; i++) r.push({ set, lang, task, id: `${prefix}${i}`, path: `${baseDir}/${set}/${prefix}${i}.json` })
  return r
}
const english = [
  ...range('w', 1, 8, 'weather', 'en', 'english'),
  ...range('o', 9, 16, 'offtopic', 'en', 'english'),
  ...range('s', 17, 24, 'summarize', 'en', 'english'),
  ...range('l', 25, 32, 'longctx', 'en', 'english'),
]
const mn = (set) => [
  ...range('w', 1, 10, 'weather', 'mn', set),
  ...range('g', 11, 20, 'general', 'mn', set),
  ...range('x', 21, 30, 'xsum', 'mn', set),
]
const entries = [...english, ...mn('mn-v1'), ...mn('mn-v2'), ...mn('mn-v3'), ...mn('mn-v4')]
log(`Grading ${entries.length} samples (32 English + 120 Mongolian across 4 prompt variants), judge + adversarial verifier each.`)

const JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    score: { type: 'integer', minimum: 1, maximum: 5 },
    faithful: { type: 'boolean' },
    correct: { type: 'boolean' },
    fluent: { type: 'boolean' },
    cyrillicOnly: { type: 'boolean' },
    pass: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['score', 'faithful', 'correct', 'pass', 'reason'],
}
const ADV_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { refuted: { type: 'boolean' }, issue: { type: 'string' } },
  required: ['refuted', 'issue'],
}

function judgePrompt(e) {
  const head = `Read the JSON file at: ${e.path}\nIf the file is unreadable or the "output" field is empty, return score 1, faithful false, correct false, pass false, reason "empty/unreadable".\nFields: task (${e.task}), question/instruction, injected (canned tool data for weather), source (grounding document), output (the answer to grade).\n`
  if (e.lang === 'mn') {
    return `You are a STRICT bilingual Mongolian (Cyrillic) output-quality judge.\n${head}` +
      `Grade the \`output\` 1-5 on faithfulness, correctness, and FLUENCY as written Mongolian:\n` +
      `- weather: must accurately reflect injected temperature_c / feels_like_c / condition; no invented numbers.\n` +
      `- xsum: must faithfully summarize the English source IN Mongolian; no hallucinated facts.\n` +
      `- general: must be factually correct.\n` +
      `FLUENCY requires: (a) ONLY Mongolian Cyrillic script — no Latin/Chinese/Japanese characters EXCEPT legitimately-kept technical/brand names (Next.js, React, vLLM, Vercel, SDK, TCP, UDP, DNS, GDP); (b) only real, existing Mongolian words (no invented or garbled words); (c) grammatical, natural phrasing.\n` +
      `An empty output, wrong language/script, invented words, or unfaithfulness caps the score at 2 and is a FAIL.\n` +
      `Return: score(1-5 int), faithful(bool), correct(bool), fluent(bool = natural grammatical native Mongolian), cyrillicOnly(bool = no stray foreign script beyond allowed brand names), pass(bool = score>=4 AND faithful AND correct), reason(one English sentence).`
  }
  return `You are a STRICT output-quality judge.\n${head}` +
    `Grade the \`output\` 1-5 on faithfulness, correctness, and helpfulness/coherence:\n` +
    `- weather: must accurately reflect the injected temperature_c / feels_like_c / condition; no invented facts.\n` +
    `- summarize / longctx: must be grounded ONLY in the source; no hallucinated APIs, names, or claims.\n` +
    `- offtopic: must be factually correct and actually answer the question.\n` +
    `A hallucination, factual error, or contradiction of the injected/source data caps the score at 2 and is a FAIL.\n` +
    `Return: score(1-5 int), faithful(bool), correct(bool), pass(bool = score>=4 AND faithful AND correct AND no hallucination), reason(one sentence).`
}

function advPrompt(e, j) {
  const extra = e.lang === 'mn'
    ? ` For Mongolian, also hunt for: any non-Mongolian script beyond allowed brand names (Next.js/React/vLLM/Vercel/SDK/TCP/UDP/DNS), invented or garbled non-words, non-native phrasing, or an empty/truncated answer.`
    : ''
  return `You are an ADVERSARIAL verifier. A judge graded this sample pass=${j.pass}, score=${j.score}.\n` +
    `Read the JSON file at: ${e.path}\n` +
    `Try HARD to REFUTE a passing grade: find a concrete hallucination, factual error, contradiction with the injected/source data, or unfaithfulness.${extra}\n` +
    `If you find a real, specific defect that should make the output FAIL, set refuted=true and name it precisely. If the output is genuinely solid, set refuted=false. Default to refuted=false unless you can point to a SPECIFIC defect.\n` +
    `Return: refuted(bool), issue(string = the specific defect, or "none").`
}

const verdicts = await pipeline(
  entries,
  (e) => agent(judgePrompt(e), { schema: JUDGE_SCHEMA, phase: 'Grade', label: `judge:${e.set}/${e.id}` }),
  (j, e) => {
    if (!j) return { set: e.set, id: e.id, task: e.task, lang: e.lang, score: 1, faithful: false, correct: false, fluent: false, cyrillicOnly: false, judgePass: false, refuted: true, pass: false, reason: 'no judge verdict' }
    return agent(advPrompt(e, j), { schema: ADV_SCHEMA, phase: 'Verify', label: `verify:${e.set}/${e.id}` })
      .then((adv) => ({
        set: e.set, id: e.id, task: e.task, lang: e.lang,
        score: j.score, faithful: j.faithful, correct: j.correct,
        fluent: j.fluent ?? null, cyrillicOnly: j.cyrillicOnly ?? null,
        judgePass: j.pass,
        refuted: adv ? adv.refuted : false,
        pass: j.pass && !(adv && adv.refuted),
        reason: (adv && adv.refuted) ? adv.issue : j.reason,
      }))
  }
)

const clean = verdicts.filter(Boolean)
const passN = clean.filter((v) => v.pass).length
log(`Graded ${clean.length}/${entries.length}; ${passN} passed (judge + adversarial).`)
return clean
