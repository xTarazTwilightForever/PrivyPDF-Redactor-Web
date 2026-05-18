import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./polyfills";
import App from "./App";
import "./styles.css";

window.addEventListener("error", (event) => {
  console.error("[PrivyPDF] Unhandled browser error", {
    message: event.message,
    filename: event.filename,
    line: event.lineno,
    column: event.colno,
    error: event.error
  });
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("[PrivyPDF] Unhandled promise rejection", event.reason);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
