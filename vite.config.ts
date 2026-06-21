/**
 * Vite configuration.
 * Proxies /api requests to the FastAPI backend during development
 * so the frontend can call the API without CORS issues.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Proxy API calls to the FastAPI backend at port 8000
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
});
