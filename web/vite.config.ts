import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const SERVER = `127.0.0.1:${process.env.KANBAN_PORT ?? 4310}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: `http://${SERVER}` },
      "/ws": { target: `ws://${SERVER}`, ws: true },
    },
  },
});
