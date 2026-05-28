import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "vLLM Weather Helper",
  description: "Streaming chat demo backed by a vLLM endpoint with a real weather tool.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
