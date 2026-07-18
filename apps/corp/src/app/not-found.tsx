import Link from "next/link";

/**
 * Global fallback for paths that don't match a locale segment.
 * It renders its own <html> because it sits outside the [locale] layout.
 */
export default function GlobalNotFound() {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#000",
          color: "#f8f8f6",
          fontFamily: "system-ui, sans-serif",
          textAlign: "center",
          gap: 16,
        }}
      >
        <h1 style={{ fontSize: 32, margin: 0 }}>404 — Page not found</h1>
        <p style={{ color: "#c3c2b7", margin: 0 }}>The page you’re looking for doesn’t exist.</p>
        <Link href="/en" style={{ color: "#5599e7" }}>
          Go to homepage
        </Link>
      </body>
    </html>
  );
}
