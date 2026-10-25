import type { NextConfig } from "next";

// Read-only client against apps/cloud; nothing here needs server-side
// rendering secrets, so plain static/client rendering is fine.
const nextConfig: NextConfig = {
  // The OAuth consent page grants an agent access to the user's workspaces
  // with one click, so it must never render inside another site's frame
  // (clickjacking), and its URL — which carries the request id — must not
  // leak to the client's logo or homepage host via Referer.
  async headers() {
    return [
      {
        source: "/oauth/consent",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
