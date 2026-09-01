/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `razorpay` is a plain Node SDK; keep it server-external so Next does not try to bundle it.
  serverExternalPackages: ["razorpay"],
  async rewrites() {
    return [
      // The approval endpoint is specified as POST /agentguard/approve. The handler
      // lives under the conventional /api prefix; this makes both paths work.
      { source: "/agentguard/approve", destination: "/api/agentguard/approve" },
    ];
  },
};

export default nextConfig;
