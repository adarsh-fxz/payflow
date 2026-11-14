"use client";

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "64px 16px", maxWidth: 520, margin: "0 auto", color: "#1f1b18" }}>
        <h1 style={{ fontSize: 24 }}>PayFlow couldn&apos;t load</h1>
        <p style={{ color: "#6b625b" }}>Something failed while loading the app. Nothing was sent from your wallet.</p>
        <button onClick={reset} style={{ marginTop: 16, padding: "8px 14px", borderRadius: 6, border: "1px solid #ccc", cursor: "pointer" }}>
          Try again
        </button>
      </body>
    </html>
  );
}
