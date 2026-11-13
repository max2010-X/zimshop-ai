import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.getRegistrations().then((registrations) =>
      Promise.all(registrations
        .filter((registration) => registration.active?.scriptURL.endsWith("/service-worker.js"))
        .map((registration) => registration.unregister())),
    );
    if ("caches" in window) void caches.delete("zimshop-shell-v1");
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);