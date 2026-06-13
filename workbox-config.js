module.exports = {
  globDirectory: "dist",
  globPatterns: [
    "**/*.{html,js,css,json,ico,png,svg,webp,woff,woff2,ttf,otf}",
  ],
  globIgnores: [
    "sw.js",
    "workbox-*.js",
  ],
  maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
  navigateFallback: "/index.html",
  navigateFallbackDenylist: [
    /^\/api\//,
  ],
  runtimeCaching: [
    {
      urlPattern: ({ request, url }) =>
        request.method === "GET" &&
        url.origin === self.location.origin &&
        (url.pathname.startsWith("/_expo/") || url.pathname.startsWith("/assets/")),
      handler: "StaleWhileRevalidate",
      options: {
        cacheName: "orbita-static-assets",
        expiration: {
          maxEntries: 120,
          maxAgeSeconds: 30 * 24 * 60 * 60,
        },
      },
    },
  ],
  skipWaiting: true,
  clientsClaim: true,
  swDest: "dist/sw.js",
};
