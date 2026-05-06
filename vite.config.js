import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Keep the browser talking only to our backend for session negotiation.
      "/session": "http://localhost:3000",
    },
  },
});
