/**
 * Vite configuration.
 * Proxies /api requests to the FastAPI backend during development
 * so the frontend can call the API without CORS issues.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const defaultBase =
  repositoryName && !repositoryName.toLowerCase().endsWith(".github.io")
    ? `/${repositoryName}/`
    : "/";

export default defineConfig({
  // Override with VITE_BASE_PATH when targeting a root Pages site such as
  // https://<owner>.github.io from a non-<owner>.github.io repository.
  base: process.env.VITE_BASE_PATH ?? defaultBase,
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
