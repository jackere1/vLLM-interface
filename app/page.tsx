"use client";

import { useChat } from "@ai-sdk/react";
import { useEffect, useRef, useState } from "react";

type WeatherResult = {
  location?: string;
  timezone?: string | null;
  temperature_c?: number;
  feels_like_c?: number;
  humidity_pct?: number;
  wind_kmh?: number;
  wind_direction_deg?: number;
  precipitation_mm?: number;
  is_day?: boolean;
  condition?: string;
  weather_code?: number;
  error?: string;
};

const SUGGESTIONS = [
  "What's the weather in Tokyo right now?",
  "Is it raining in London?",
  "How cold is it in Reykjavik vs. Oslo?",
  "Should I take a jacket in Austin today?",
];

export default function Page() {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status, error } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, status]);

  const busy = status === "submitted" || status === "streaming";

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    sendMessage({ text: trimmed });
    setInput("");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col px-4 pb-6 pt-8 sm:pt-12">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-400 to-indigo-500 text-white shadow-lg shadow-sky-300/50">
            <SunIcon className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-slate-900">
              vLLM Weather Helper
            </h1>
            <p className="text-xs text-slate-500">
              Streaming via Vercel AI SDK · model{" "}
              <span className="font-mono text-slate-700">gemma-4-31b</span>
            </p>
          </div>
        </div>
        <span className="hidden rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 sm:inline-flex">
          <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
          live
        </span>
      </header>

      <div
        ref={scrollRef}
        className="chat-scroll flex-1 space-y-4 overflow-y-auto rounded-3xl border border-white/60 bg-white/60 p-4 shadow-xl shadow-slate-200/60 backdrop-blur sm:p-6"
      >
        {messages.length === 0 && <EmptyState onPick={(s) => submit(s)} />}

        {messages.map((m) => (
          <MessageBubble key={m.id} role={m.role}>
            {m.parts.map((part, i) => {
              if (part.type === "text") {
                return (
                  <p
                    key={i}
                    className="whitespace-pre-wrap break-words leading-relaxed"
                  >
                    {part.text}
                  </p>
                );
              }
              if (part.type === "tool-get_weather") {
                return <WeatherToolCard key={i} part={part} />;
              }
              return null;
            })}
          </MessageBubble>
        ))}

        {busy && messages[messages.length - 1]?.role === "user" && (
          <MessageBubble role="assistant">
            <span className="inline-flex items-center text-slate-500">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </span>
          </MessageBubble>
        )}

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            Something went wrong: {error.message}
          </div>
        )}
      </div>

      <form
        className="mt-4 flex items-center gap-2 rounded-full border border-white/70 bg-white/80 p-1.5 shadow-lg shadow-slate-200/60 backdrop-blur"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <input
          data-testid="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about the weather anywhere…"
          className="flex-1 bg-transparent px-4 py-2.5 text-sm text-slate-900 outline-none placeholder:text-slate-400"
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 to-indigo-600 text-white shadow-md transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Send"
        >
          <SendIcon className="h-4 w-4" />
        </button>
      </form>
    </main>
  );
}

function EmptyState({ onPick }: { onPick: (s: string) => void }) {
  return (
    <div className="flex flex-col items-center gap-5 px-2 py-8 text-center sm:py-12">
      <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-gradient-to-br from-sky-100 to-indigo-100 text-sky-500 shadow-inner">
        <SunIcon className="h-8 w-8" />
      </div>
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-900">
          Ask about the weather, anywhere on earth.
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Powered by your vLLM endpoint, with real conditions from Open-Meteo.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({
  role,
  children,
}: {
  role: "user" | "assistant" | "system";
  children: React.ReactNode;
}) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={
          isUser
            ? "max-w-[85%] rounded-2xl rounded-br-md bg-gradient-to-br from-sky-500 to-indigo-600 px-4 py-2.5 text-sm text-white shadow-md"
            : "max-w-[85%] space-y-3 rounded-2xl rounded-bl-md border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-800 shadow-sm"
        }
      >
        {children}
      </div>
    </div>
  );
}

function WeatherToolCard({
  part,
}: {
  part: {
    state: string;
    input?: { location?: string };
    output?: WeatherResult;
    errorText?: string;
  };
}) {
  const { state, input, output, errorText } = part;

  if (state === "input-streaming" || state === "input-available") {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
        <Spinner />
        Looking up weather{input?.location ? ` for ${input.location}` : ""}…
      </div>
    );
  }

  if (state === "output-error") {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
        Weather tool failed: {errorText ?? "unknown error"}
      </div>
    );
  }

  if (state !== "output-available" || !output) return null;
  if (output.error) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        {output.error}
      </div>
    );
  }

  const isDay = !!output.is_day;
  return (
    <div
      className={`overflow-hidden rounded-2xl border ${
        isDay
          ? "border-sky-200 bg-gradient-to-br from-sky-50 to-indigo-50"
          : "border-indigo-200 bg-gradient-to-br from-indigo-50 to-slate-100"
      }`}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {output.location}
          </div>
          <div className="mt-0.5 text-2xl font-semibold tracking-tight text-slate-900">
            {Math.round(output.temperature_c ?? 0)}°C
            <span className="ml-2 text-sm font-normal text-slate-500">
              feels {Math.round(output.feels_like_c ?? 0)}°
            </span>
          </div>
          <div className="text-xs text-slate-600">{output.condition}</div>
        </div>
        <div className={isDay ? "text-amber-500" : "text-indigo-400"}>
          {isDay ? (
            <SunIcon className="h-10 w-10" />
          ) : (
            <MoonIcon className="h-10 w-10" />
          )}
        </div>
      </div>
      <div className="grid grid-cols-3 divide-x divide-white/60 border-t border-white/70 bg-white/40 text-center text-xs text-slate-600">
        <Stat label="Humidity" value={`${output.humidity_pct ?? 0}%`} />
        <Stat label="Wind" value={`${Math.round(output.wind_kmh ?? 0)} km/h`} />
        <Stat
          label="Precip"
          value={`${(output.precipitation_mm ?? 0).toFixed(1)} mm`}
        />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-2">
      <div className="font-semibold text-slate-800">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </div>
    </div>
  );
}

function SunIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SendIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M22 2 11 13" />
      <path d="m22 2-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin text-slate-400"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M22 12a10 10 0 0 0-10-10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
