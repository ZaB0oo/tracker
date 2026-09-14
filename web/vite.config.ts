import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // object form: changeOrigin stays false, so the Host the server sees is
      // localhost:5173 and matches the Origin (apiGuard refuses a mismatch)
      "/api": { target: "http://localhost:3727", changeOrigin: false },
    },
  },
});
