/* Rendered by next/og (Satori): inline styles only, flexbox layout. */
export const OG_SIZE = { width: 1200, height: 630 };

function Mark() {
  return (
    <div style={{ display: "flex", width: 56, height: 56, borderRadius: 14, background: "#1f1b18", position: "relative" }}>
      <div style={{ position: "absolute", left: 12, top: 16, width: 24, height: 9, borderRadius: 3, background: "#ffffff" }} />
      <div style={{ position: "absolute", left: 21, top: 31, width: 24, height: 9, borderRadius: 3, background: "#ec9402" }} />
    </div>
  );
}

export function OgCard({ title, subtitle, footer }: { title: string; subtitle?: string; footer?: string }) {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: "#ffffff", padding: 72, color: "#1f1b18", fontFamily: "sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <Mark />
        <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: -0.5 }}>PayFlow</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {subtitle ? <div style={{ fontSize: 32, color: "#6b625b" }}>{subtitle}</div> : null}
        <div style={{ fontSize: title.length > 40 ? 64 : 84, fontWeight: 700, letterSpacing: -2, lineHeight: 1.05, maxWidth: 1000 }}>{title}</div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "2px solid #ece9e6", paddingTop: 28, fontSize: 26, color: "#6b625b" }}>
        <div>{footer ?? "Payroll without borders. Payments powered by MUSD."}</div>
        <div style={{ display: "flex", width: 120, height: 10, borderRadius: 5, background: "#ec9402" }} />
      </div>
    </div>
  );
}
