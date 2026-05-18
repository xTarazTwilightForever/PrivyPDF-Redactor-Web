import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/PrivyPDF-Redactor-Web/",
  plugins: [react()],
  build: {
    target: "safari13"
  }
});
