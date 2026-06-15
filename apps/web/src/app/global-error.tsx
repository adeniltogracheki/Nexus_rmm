"use client";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="pt-BR">
      <body style={{ background: "#0f1117", color: "#e4e8f0", fontFamily: "system-ui", display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", margin: 0 }}>
        <div style={{ textAlign: "center", padding: "2rem" }}>
          <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>⚠️</div>
          <h2 style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "0.5rem" }}>Algo deu errado</h2>
          <p style={{ color: "#6b7595", fontSize: "0.875rem", marginBottom: "1.5rem" }}>Um erro inesperado ocorreu. Por favor, tente novamente.</p>
          <button
            onClick={() => reset()}
            style={{ padding: "0.5rem 1.5rem", borderRadius: "0.75rem", background: "#00FFA720", border: "1px solid #00FFA740", color: "#00FFA7", cursor: "pointer", fontSize: "0.875rem", fontWeight: "600" }}
          >
            Tentar novamente
          </button>
        </div>
      </body>
    </html>
  );
}
