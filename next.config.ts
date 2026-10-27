import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  agentRules: false,
  experimental: { agentUpgrade: 'security' },
};

export default nextConfig;
