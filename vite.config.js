import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Keep the browser talking only to our backend for session negotiation and TTS proxying.
      "/api/session": "http://localhost:3001",
      "/api/conversations": "http://localhost:3001",
      "/api/tts": {
        target: "http://localhost:3001",
        ws: true,
      },
    },
  },
});
