import type{NextConfig}from"next";
const securityHeaders=[["X-Content-Type-Options","nosniff"],["Referrer-Policy","strict-origin-when-cross-origin"],["X-Frame-Options","DENY"],["Permissions-Policy","camera=(),microphone=(),geolocation=()"],["Cross-Origin-Opener-Policy","same-origin"]];
const nextConfig:NextConfig={poweredByHeader:false,reactStrictMode:true,async headers(){return[{source:"/:path*",headers:securityHeaders.map(([key,value])=>({key,value}))}]}}
export default nextConfig;