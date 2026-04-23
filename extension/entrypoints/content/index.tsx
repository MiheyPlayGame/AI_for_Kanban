import React from "react";
import { createRoot } from "react-dom/client";
import { defineContentScript } from "wxt/utils/define-content-script";
import ExtensionPanelApp from "../../src/components/ExtensionPanelApp";
import "../../src/styles/panel.css";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  main() {
    const existing = document.getElementById("kanban-ai-extension-root");
    if (existing) {
      return;
    }

    const container = document.createElement("div");
    container.id = "kanban-ai-extension-root";
    document.body.appendChild(container);
    createRoot(container).render(<ExtensionPanelApp />);
  }
});
