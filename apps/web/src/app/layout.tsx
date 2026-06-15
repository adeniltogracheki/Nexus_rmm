import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Nexus RMM — Controle total da sua frota de TI",
  description:
    "RMM brasileiro para MSPs: acesso remoto, terminal, inventário, manutenção e relatórios. Instale em 1 comando.",
  openGraph: {
    title: "Nexus RMM — Controle total da sua frota de TI",
    description:
      "RMM brasileiro para MSPs: acesso remoto, terminal, inventário, manutenção e relatórios. Instale em 1 comando.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="pt-BR"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        {/* PWA */}
        <meta name="theme-color" content="#07070a" />
        <meta name="application-name" content="Nexus RMM" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Nexus RMM" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
        <link rel="manifest" href="/manifest.json" />
        {/* Ícone iOS (fallback enquanto os PNGs não estiverem prontos) */}
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
