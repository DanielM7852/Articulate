import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [react(), tailwind()],
  build: {
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL("./index.html", import.meta.url)),
        vision: fileURLToPath(new URL("./vision.html", import.meta.url)),
      },
    },
  },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", ws: true },
      "/health": "http://127.0.0.1:8000",
    },
  },
});
