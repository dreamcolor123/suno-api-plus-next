import type { Metadata } from "next";
import "./globals.css";
import Header from "./components/Header";
import Footer from "./components/Footer";
import { Analytics } from "@vercel/analytics/react"

export const metadata: Metadata = {
  title: "Suno API Plus Next",
  description: "Self-hosted Suno API gateway with Studio workflows and OpenAI-compatible endpoints.",
  keywords: ["suno", "suno api", "suno.ai", "api", "music", "generation", "ai"],
  creator: "dreamcolor123",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="overflow-y-scroll">
        <Header />
        <main className="flex flex-col items-center m-auto w-full">
          {children}
        </main>
        <Footer />
        <Analytics />
      </body>
    </html>
  );
}
