import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  lint: { options: { typeAware: true, typeCheck: true } },
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/utxos": "http://localhost:3000",
      "/tx": "http://localhost:3000",
    },
  },
});
