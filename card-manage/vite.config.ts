import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const srcDir = decodeURIComponent(new URL("./src", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": srcDir,
    },
  },
  server: {
    port: 5178,
  },
});
