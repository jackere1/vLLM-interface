import type { UIMessage, UIDataTypes } from "ai";

export type WeatherSuccess = {
  location: string;
  timezone: string | null;
  temperature_c: number;
  feels_like_c: number;
  humidity_pct: number;
  wind_kmh: number;
  wind_direction_deg: number;
  precipitation_mm: number;
  is_day: boolean;
  weather_code: number;
  condition: string;
};

export type WeatherToolOutput = WeatherSuccess | { error: string };

export type ChatTools = {
  get_weather: {
    input: { location: string };
    output: WeatherToolOutput;
  };
};

export type ChatMessage = UIMessage<never, UIDataTypes, ChatTools>;
