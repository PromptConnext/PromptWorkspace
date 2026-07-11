import type { NextConfig } from "next";

// Read-only client against apps/cloud; nothing here needs server-side
// rendering secrets, so plain static/client rendering is fine.
const nextConfig: NextConfig = {};

export default nextConfig;
