import React from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import ExtensionPanelApp from "../../src/components/ExtensionPanelApp";
import "../../src/styles/panel.css";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  main() {
    const rootId = "kanban-ai-extension-root";
    const listenerKey = "__asyaToggleListenerAttached__";

    if (!(window as any)[listenerKey]) {
      browser.runtime.onMessage.addListener((message: { type?: string }) => {
        if (message?.type === "togglePanel") {
          window.dispatchEvent(new CustomEvent("asya:toggle-panel"));
        }
      });
      (window as any)[listenerKey] = true;
    }

    // Remove stale root left from previous extension runtime.
    const existing = document.getElementById(rootId);
    if (existing) {
      existing.remove();
    }

    const container = document.createElement("div");
    container.id = rootId;
    document.body.appendChild(container);
    createRoot(container).render(<ExtensionPanelApp />);
  }
});
