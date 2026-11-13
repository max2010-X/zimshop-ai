import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      input: {
        landing: "index.html",
        workspace: "workspace.html",
        landingTrial: "zimshop-ai-landing-trial-ecocash.html",
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 4176,
    strictPort: true,
    watch: {
      ignored: ["**/backend/.venv/**"],
    },
    proxy: {
      "/api": "http://localhost:8000",
      "/health": "http://localhost:8000",
      "/uploads": "http://localhost:8000",
    },
  },
  envPrefix: ["VITE_"],
});