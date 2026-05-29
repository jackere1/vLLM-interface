// Real technical-documentation chunks pulled via Context7 (Next.js, vLLM,
// React, Vercel AI SDK). Used by stress-test-longcontext.mjs to assemble
// coherent long-context documents to summarize / reason over.
//
// Each chunk is a self-contained doc section (prose + representative code).
// The harness concatenates shuffled chunks (with a unique title) to build
// documents of ~1K / 2K / 4K tokens.

export const CHUNKS = [
  {
    title: "Next.js — Data fetching in Server Components",
    text: `In the App Router, data fetching is colocated inside async Server Components using the fetch API. The caching behavior is controlled per request. \`fetch(url, { cache: 'force-cache' })\` caches until manually invalidated (like getStaticProps) and is the default. \`fetch(url, { cache: 'no-store' })\` refetches on every request (like getServerSideProps). Time-based revalidation uses \`fetch(url, { next: { revalidate: 10 } })\` to cache with a 10-second lifetime.

export default async function Page() {
  const staticData = await fetch('https://...', { cache: 'force-cache' })
  const dynamicData = await fetch('https://...', { cache: 'no-store' })
  const revalidated = await fetch('https://...', { next: { revalidate: 10 } })
  return <div>...</div>
}`,
  },
  {
    title: "Next.js — Server Components passing data to Client Components",
    text: `A Server Component can fetch data directly with async/await and forward it to a Client Component as props. This replaces getServerSideProps and getStaticProps with a simpler pattern and keeps secrets on the server.

import HomePage from './home-page'
async function getPosts() {
  const res = await fetch('https://...')
  return res.json()
}
export default async function Page() {
  const recentPosts = await getPosts()
  return <HomePage recentPosts={recentPosts} />
}`,
  },
  {
    title: "Next.js — Streaming with Suspense",
    text: `React's Suspense component enables streaming server rendering and selective hydration. Wrap components that perform async work and provide a fallback UI; the page streams in as each boundary resolves, improving perceived performance.

import { Suspense } from 'react'
import { PostFeed, Weather } from './Components'
export default function Posts() {
  return (
    <section>
      <Suspense fallback={<p>Loading feed...</p>}><PostFeed /></Suspense>
      <Suspense fallback={<p>Loading weather...</p>}><Weather /></Suspense>
    </section>
  )
}`,
  },
  {
    title: "Next.js — Dynamic routes with params",
    text: `A dynamic segment like [slug] receives a params prop. In recent versions params is a Promise that must be awaited before use. The component fetches the matching record and renders it.

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const post = await getPost(slug)
  return (<div><h1>{post.title}</h1><p>{post.content}</p></div>)
}`,
  },
  {
    title: "Next.js — Dynamic metadata",
    text: `generateMetadata lets a route fetch data and set its metadata dynamically — ideal when the title or description depends on route params or an external API.

export async function generateMetadata({ params }, parent): Promise<Metadata> {
  const slug = (await params).slug
  const post = await fetch(\`https://api.vercel.app/blog/\${slug}\`).then(r => r.json())
  return { title: post.title, description: post.description }
}`,
  },
  {
    title: "Next.js — Server Actions for mutations",
    text: `Mutations should be handled by Server Actions, invoked from a <form> so they only run on explicit user interaction (never as a side effect of rendering). This keeps mutation logic on the server and avoids accidental writes during render.

import { logout } from './actions'
export default function Page() {
  return (<><UserProfile /><form action={logout}><button type="submit">Logout</button></form></>)
}`,
  },
  {
    title: "Next.js — Route handler with error handling",
    text: `A POST route handler should wrap work in try/catch, return appropriate HTTP status codes, and avoid leaking sensitive error detail to clients.

import { submit } from '@/lib/submit'
export async function POST(request: Request) {
  try {
    await submit(request)
    return new Response(null, { status: 204 })
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : 'Unexpected error'
    return new Response(message, { status: 500 })
  }
}`,
  },
  {
    title: "vLLM — OpenAI-compatible Chat API",
    text: `vLLM exposes an HTTP server implementing the OpenAI API protocol, acting as a drop-in replacement. POST /v1/chat/completions accepts messages (the conversation history), plus optional model, stream, max_tokens, temperature, top_p, and stop. The response contains choices and a usage object with prompt_tokens, completion_tokens, and total_tokens. parallel_tool_calls controls whether more than one tool call is allowed per request (default true).`,
  },
  {
    title: "vLLM — Server endpoints overview",
    text: `The server provides multiple OpenAI-compatible endpoints: /v1/completions for raw text generation, /v1/chat/completions for chat with message history and tools, /v1/embeddings for embeddings, and /v1/audio/transcriptions and /v1/audio/translations for speech. It hosts one model at a time and provides a models listing endpoint. The host and port default to localhost:8000 and are configurable with --host and --port.`,
  },
  {
    title: "vLLM — Conserving memory",
    text: `Memory usage can be reduced by limiting context length with max_model_len and the maximum batch size with max_num_seqs. This is useful under memory constraints or when sequences are short.

from vllm import LLM
llm = LLM(model="adept/fuyu-8b", max_model_len=2048, max_num_seqs=2)`,
  },
  {
    title: "vLLM — Tensor parallelism",
    text: `Tensor parallelism shards model parameters across multiple GPUs within each layer, which is essential for models too large to fit on a single GPU. Set tensor_parallel_size to the number of GPUs.

from vllm import LLM
llm = LLM(model="meta-llama/Llama-3.3-70B-Instruct", tensor_parallel_size=4)`,
  },
  {
    title: "vLLM — PagedAttention, batching and chunked prefill",
    text: `vLLM achieves high serving throughput through PagedAttention, which efficiently manages attention key/value memory, plus continuous batching of incoming requests, chunked prefill, and prefix caching. Chunked prefill improves inter-token latency (ITL) and decode by prioritizing decode requests and batching compute-bound prefill with memory-bound decode. Tuning max_num_batched_tokens trades off TTFT and ITL: smaller values improve ITL, larger values improve TTFT; values above 8192 are recommended for throughput on large GPUs.`,
  },
  {
    title: "React — Built-in hook categories",
    text: `React's built-in Hooks fall into categories. State Hooks: useState (direct updates) and useReducer (update logic in a reducer). Context Hooks: useContext reads and subscribes to a context. Ref Hooks: useRef and useImperativeHandle. Effect Hooks: useEffect connects to external systems, useLayoutEffect fires before paint, useInsertionEffect for libraries injecting CSS. Performance Hooks: useMemo caches expensive results, useCallback caches function definitions, useTransition and useDeferredValue keep the UI responsive. Other Hooks: useId, useSyncExternalStore, useActionState.`,
  },
  {
    title: "React — Effects with cleanup",
    text: `Effects that connect to an external system should return a cleanup function. A chat connection must disconnect on cleanup so connections do not accumulate. For data fetching, an "ignore" flag prevents a stale response from overwriting fresh state.

useEffect(() => {
  let ignore = false;
  async function start() { const json = await fetchTodos(userId); if (!ignore) setTodos(json); }
  start();
  return () => { ignore = true; };
}, [userId]);`,
  },
  {
    title: "React — useReducer with Context",
    text: `For complex state, a parent manages it with useReducer while Context passes both state and dispatch deep into the tree, so any descendant can read state and dispatch actions without prop drilling.

const [tasks, dispatch] = useReducer(tasksReducer, initialTasks);
function tasksReducer(tasks, action) {
  switch (action.type) {
    case 'added': return [...tasks, { id: action.id, text: action.text, done: false }];
    case 'changed': return tasks.map(t => t.id === action.task.id ? action.task : t);
    case 'deleted': return tasks.filter(t => t.id !== action.id);
    default: throw Error('Unknown action: ' + action.type);
  }
}`,
  },
  {
    title: "Vercel AI SDK — Multi-step streamText agent",
    text: `A multi-step agent chains streamText calls inside createUIMessageStream. Step 1 can force a tool call (toolChoice: 'required'); step 2 continues the workflow with a different model/system prompt and the messages from the previous step. Results are merged into one UI message stream, controlling start/finish events.

const result1 = streamText({ model: 'openai/gpt-4o-mini', system: 'Extract the user goal.', messages, toolChoice: 'required', tools: { extractGoal: tool({ inputSchema: z.object({ goal: z.string() }), execute: async ({ goal }) => goal }) } });
writer.merge(result1.toUIMessageStream({ sendFinish: false }));
const result2 = streamText({ model: 'openai/gpt-4o', system: 'Repeat the extracted goal.', messages: [...convertToModelMessages(messages), ...(await result1.response).messages] });
writer.merge(result2.toUIMessageStream({ sendStart: false }));`,
  },
  {
    title: "Vercel AI SDK — streamText and structured output",
    text: `streamText streams text from a model and prompt; the output is available as a textStream, with a fullStream of typed parts and tool-call handling, retries, and telemetry built in. streamObject is deprecated in favor of streamText with the output setting and Output.object to stream structured data validated by a zod schema.

const { partialOutputStream } = streamText({ model, output: Output.object({ schema: z.object({ recipe: z.object({ name: z.string(), steps: z.array(z.string()) }) }) }), prompt: 'Generate a lasagna recipe.' });
for await (const partial of partialOutputStream) console.log(partial);`,
  },
  {
    title: "Vercel AI SDK — useChat on the client",
    text: `The useChat hook from @ai-sdk/react manages chat state on the client. It exposes messages and sendMessage; each message has parts that can be text or tool-call parts, which the UI renders accordingly.

const { messages, sendMessage } = useChat();
messages.map(m => m.parts.map((part, i) => part.type === 'text' ? <span key={i}>{part.text}</span> : <pre key={i}>{JSON.stringify(part, null, 2)}</pre>));`,
  },
];

// Doc-agnostic instructions for the two task types.
export const SUMMARIZE_TEMPLATES = [
  "Summarize the following documentation in 3–4 sentences:",
  "Give a concise TL;DR (2–3 sentences) of the documentation below:",
  "Write a short summary of the key points in the documentation below:",
];
export const COMPLEX_QUESTIONS = [
  "Based on the documentation above, explain the main concepts and how they fit together.",
  "Using only the documentation above, list the key steps or APIs a developer would use and what each is for.",
  "Compare the different approaches described above and explain the trade-offs.",
  "What problems do the features described above solve, and when would you choose each?",
  "Summarize the most important caveats or gotchas a developer should know from the text above.",
  "If you were teaching this to a junior engineer, what are the three most important takeaways from the text above?",
];
