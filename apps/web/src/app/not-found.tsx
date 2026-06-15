"use client";

import Link from "next/link";

export default function NotFound() {
  return (
    <div style={{ background: "#0f1117", color: "#e4e8f0", fontFamily: "system-ui", display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", margin: 0 }}>
      <div style={{ textAlign: "center", padding: "2rem" }}>
        <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>🔍</div>
        <h2 style={{ fontSize: "1.5rem", fontWeight: "bold", marginBottom: "0.5rem" }}>Página não encontrada</h2>
        <p style={{ color: "#6b7595", fontSize: "0.875rem", marginBottom: "1.5rem" }}>A página que você procura não existe.</p>
        <Link href="/painel" style={{ padding: "0.5rem 1.5rem", borderRadius: "0.75rem", background: "#00FFA720", border: "1px solid #00FFA740", color: "#00FFA7", textDecoration: "none", fontSize: "0.875rem", fontWeight: "600" }}>
          Voltar ao painel
        </Link>
      </div>
    </div>
  );
}
