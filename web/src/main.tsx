import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App.tsx";
import { AppDataProvider } from "./lib/store.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";

// The last resort: whatever throws, the page says so instead of going black.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <AppDataProvider>
        <App />
      </AppDataProvider>
    </ErrorBoundary>
  </StrictMode>,
);
