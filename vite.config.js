import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  server: {
    proxy: {
      "/odds-api": {
        target: "https://api.the-odds-api.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/odds-api/, "")
      }
    }
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      devOptions: {
        enabled: true
      },
      manifest: {
        name: "MLB Schedule Viewer",
        short_name: "MLB Viewer",
        description: "MLB games, pitchers, lineups and streak stats.",
        theme_color: "#111827",
        background_color: "#f3f4f6",
        display: "standalone",
        scope: "/",
        start_url: "/",
        icons: [
          {
            src: "/pwa-icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any"
          },
          {
            src: "/pwa-maskable.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "maskable"
          }
        ]
      }
    })
  ]
});
