// Read at BUILD time, not at request time. `vercel build` runs on the GitHub
// runner, where the PZ_WEB_ORIGIN repository variable is in the environment, so
// the header below is baked into the routes manifest and needs no Vercel
// project environment variable to exist.
//
// Naming the PromptZone web origin as a frame ancestor is what lets the
// project's Preview tab embed this app instead of falling back to a link card.
// When the variable is absent no header is emitted at all, and the app still
// frames — an absent CSP is permissive. That is the same trade `server.js`
// makes in the fly-node template.
const WEB_ORIGIN = process.env.PZ_WEB_ORIGIN || "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    if (!WEB_ORIGIN) return [];
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "content-security-policy",
            value: `frame-ancestors ${WEB_ORIGIN}`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
