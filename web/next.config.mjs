/** @type {import('next').NextConfig} */
// Project Pages serve under /<repo>/. Set BASE_PATH=/adcc-rankings in CI so
// assets + data resolve; empty locally (npm run dev serves at root).
const basePath = process.env.BASE_PATH || "";

const nextConfig = {
  reactStrictMode: true,
  output: "export",   // emit static HTML/JS to web/out/ — no server needed
  images: { unoptimized: true },
  outputFileTracingRoot: import.meta.dirname,  // repo has 2 lockfiles; pin root
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },  // client reads this to fetch data
};
export default nextConfig;
