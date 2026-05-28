import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { z } from "zod";
import type { ChatMessage, WeatherToolOutput } from "@/app/lib/chat-types";

const VLLM_BASE_URL = "https://jungle-cia-spot-rna.trycloudflare.com/v1";
const VLLM_API_KEY =
  "a39e4fb12f8062efbb56dbb5be6fc8d3b58af30629afae586aaa8850c5ea8a0c";
// Model id as exposed by /v1/models on the vLLM server.
// (Underlying weights: LilaRest/gemma-4-31B-it-NVFP4-turbo)
const MODEL = "gemma-4-31b";

const SYSTEM_PROMPT = `You are a friendly, concise weather assistant.

When the user asks about the weather in a place, ALWAYS call the get_weather tool to fetch real, current conditions — do not guess. After you receive the tool result, summarise it in plain English in one or two sentences: temperature, what it feels like, and the overall condition. Mention wind or precipitation only if notable.

For non-weather questions, answer briefly and helpfully.`;

const vllm = createOpenAICompatible({
  name: "vllm",
  baseURL: VLLM_BASE_URL,
  apiKey: VLLM_API_KEY,
});

export const maxDuration = 60;

export async function POST(req: Request) {
  const { messages }: { messages: ChatMessage[] } = await req.json();

  const result = streamText({
    model: vllm.chatModel(MODEL),
    system: SYSTEM_PROMPT,
    messages: convertToModelMessages(messages),
    stopWhen: stepCountIs(4),
    tools: {
      get_weather: tool({
        description:
          "Get the current real-world weather for a city or location. Returns temperature in Celsius, feels-like, humidity, wind, precipitation, and a textual condition.",
        inputSchema: z.object({
          location: z
            .string()
            .describe(
              'City name, optionally with country/region. Examples: "Tokyo", "Paris, France", "Austin, Texas".',
            ),
        }),
        execute: async ({ location }): Promise<WeatherToolOutput> => {
          const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
            location,
          )}&count=1&language=en&format=json`;
          const geoRes = await fetch(geoUrl);
          if (!geoRes.ok) {
            return { error: `Geocoding failed: ${geoRes.status}` };
          }
          const geo = (await geoRes.json()) as {
            results?: Array<{
              latitude: number;
              longitude: number;
              name: string;
              country?: string;
              admin1?: string;
              timezone?: string;
            }>;
          };
          if (!geo.results?.length) {
            return { error: `Could not find a place called "${location}".` };
          }
          const { latitude, longitude, name, country, admin1, timezone } =
            geo.results[0];

          const wxUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m&timezone=auto`;
          const wxRes = await fetch(wxUrl);
          if (!wxRes.ok) {
            return { error: `Weather lookup failed: ${wxRes.status}` };
          }
          const wx = (await wxRes.json()) as {
            current: {
              temperature_2m: number;
              relative_humidity_2m: number;
              apparent_temperature: number;
              is_day: 0 | 1;
              precipitation: number;
              weather_code: number;
              wind_speed_10m: number;
              wind_direction_10m: number;
            };
          };
          const c = wx.current;

          const fullName = [name, admin1, country].filter(Boolean).join(", ");
          return {
            location: fullName,
            timezone: timezone ?? null,
            temperature_c: c.temperature_2m,
            feels_like_c: c.apparent_temperature,
            humidity_pct: c.relative_humidity_2m,
            wind_kmh: c.wind_speed_10m,
            wind_direction_deg: c.wind_direction_10m,
            precipitation_mm: c.precipitation,
            is_day: c.is_day === 1,
            weather_code: c.weather_code,
            condition: weatherCodeToText(c.weather_code),
          };
        },
      }),
    },
  });

  return result.toUIMessageStreamResponse();
}

function weatherCodeToText(code: number): string {
  const map: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Light freezing drizzle",
    57: "Dense freezing drizzle",
    61: "Light rain",
    63: "Moderate rain",
    65: "Heavy rain",
    66: "Light freezing rain",
    67: "Heavy freezing rain",
    71: "Light snow",
    73: "Moderate snow",
    75: "Heavy snow",
    77: "Snow grains",
    80: "Rain showers",
    81: "Heavy rain showers",
    82: "Violent rain showers",
    85: "Light snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail",
    99: "Thunderstorm with heavy hail",
  };
  return map[code] ?? `Unknown (code ${code})`;
}
