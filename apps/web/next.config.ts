import type { NextConfig } from "next";

const serverUrl = process.env.NEXUS_SERVER_INTERNAL_URL || "http://localhost:4000";

// Cabeçalhos de segurança HTTP aplicados a todas as rotas.
// Mitigações: clickjacking, MIME sniffing, downgrade HTTPS, info-leak por Referer,
// framing externo e permissões de hardware não utilizadas.
const securityHeaders = [
  // Impede que o painel seja embutido em iframes externos (anti-clickjacking).
  { key: "X-Frame-Options", value: "DENY" },
  // Desativa o MIME-type sniffing do browser.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Força HTTPS por 2 anos, incluindo subdomínios (HSTS).
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  // Limita informação de referência para requisições cross-origin.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Desativa recursos de hardware não utilizados pelo painel.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), usb=()" },
  // Content Security Policy:
  //   - unsafe-inline + unsafe-eval: necessários para Next.js App Router e noVNC (canvas/eval).
  //   - connect-src ws://* wss://*: necessário para Socket.io e relay de tela.
  //   - img-src data: blob:: necessário para noVNC (capturas de tela) e logos em base64.
  //   - worker-src blob:: noVNC pode usar web workers.
  //   - frame-ancestors 'none': reforça o X-Frame-Options no nível CSP.
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "worker-src blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  // Cabeçalhos de segurança em todas as rotas da aplicação.
  // Obs.: /_next/static/* é tratado à parte pelo Next.js e não é afetado por esta regra.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },

  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${serverUrl}/api/:path*`,
      },
      {
        source: "/socket.io/:path*",
        destination: `${serverUrl}/socket.io/:path*`,
      },
      {
        source: "/instalar.ps1",
        destination: `${serverUrl}/instalar.ps1`,
      },
    ];
  },
};

export default nextConfig;
