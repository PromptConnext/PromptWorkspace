import { ImageResponse } from "next/og";
import { siteConfig } from "@/lib/site";

export const runtime = "edge";
export const alt = `${siteConfig.name} — ${siteConfig.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background: "#000000",
          backgroundImage:
            "radial-gradient(60% 60% at 50% 0%, rgba(85,153,231,0.25) 0%, transparent 70%)",
          color: "#f8f8f6",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 40 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 12,
              background: "#5599e7",
              color: "#000000",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 40,
              fontWeight: 700,
            }}
          >
            P
          </div>
          <div style={{ fontSize: 40, fontWeight: 600 }}>{siteConfig.name}</div>
        </div>
        <div style={{ fontSize: 64, fontWeight: 700, lineHeight: 1.1, maxWidth: 900 }}>
          {siteConfig.tagline}
        </div>
        <div style={{ marginTop: 32, fontSize: 30, color: "#c3c2b7", maxWidth: 900 }}>
          Bring your own model. No model tax. Requirement to running code.
        </div>
      </div>
    ),
    size,
  );
}
