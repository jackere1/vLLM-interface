# vLLM Weather Helper (Next.js)

Streaming chat demo for a vLLM inference server. Built with Next.js 15 + Vercel AI SDK 5. Includes a real `get_weather` tool backed by Open-Meteo (no API key required).

## Stack

- Next.js 15 (App Router)
- Vercel AI SDK 5 (`ai`, `@ai-sdk/openai-compatible`, `@ai-sdk/react`)
- Tailwind CSS v4
- TypeScript

## Configuration

For this throwaway demo, the vLLM base URL, bearer token, and model name are hardcoded in `app/api/chat/route.ts`. Edit them there if you rotate the tunnel or swap models.

```ts
const VLLM_BASE_URL = "https://jungle-cia-spot-rna.trycloudflare.com/v1";
const VLLM_API_KEY  = "...";
const MODEL         = "LilaRest/gemma-4-31B-it-NVFP4-turbo";
```

## Local dev

```bash
npm install
npm run dev
# open http://localhost:3000
```

## Deploy to Vercel

1. Push to GitHub (already done if you cloned this repo).
2. Go to [vercel.com/new](https://vercel.com/new), import the repo.
3. Framework preset: Next.js. No env vars to set — everything is hardcoded.
4. Deploy.

## Tool calling note

The model must be served by vLLM with native tool calling enabled, e.g.:

```bash
vllm serve <model> \
  --enable-auto-tool-choice \
  --tool-call-parser <parser>   # e.g. hermes, mistral, llama3_json
```

If the model doesn't return native tool calls, the chat will still stream text but won't fetch live weather.
