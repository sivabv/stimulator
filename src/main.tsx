/**
 * Application entry point.
 * Renders the root App component into the DOM.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";

// Minimal global reset — Ant Design provides its own baseline styles
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
