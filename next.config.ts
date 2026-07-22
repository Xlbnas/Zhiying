import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
  // Remotion 组件在服务端渲染（RSC/SSR）时不打包，浏览器端由 Player 使用
  serverExternalPackages: ['better-sqlite3'],
  webpack: (config) => {
    config.externals = [...(config.externals ?? []), 'better-sqlite3'];
    return config;
  },
};

export default nextConfig;
