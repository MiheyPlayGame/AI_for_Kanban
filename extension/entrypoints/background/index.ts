import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:8000";

type Tokens = {
  access_token: string;
  refresh_token: string;
  token_type: string;
};

type RuntimeMessage =
  | { type: "health" }
  | { type: "register"; id: string; password: string }
  | { type: "login"; id: string; password: string }
  | { type: "createChat"; accessToken: string }
  | { type: "listChats"; accessToken: string }
  | { type: "getMessages"; accessToken: string; chatId: string }
  | { type: "sendMessage"; accessToken: string; chatId: string; content: string }
  | { type: "saveTokens"; tokens: Tokens | null };

async function getApiBaseUrl() {
  const config = await browser.storage.local.get("apiBaseUrl");
  return (config.apiBaseUrl as string) || DEFAULT_API_BASE_URL;
}

async function request(path: string, options: RequestInit = {}) {
  const baseUrl = await getApiBaseUrl();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  if (!response.ok) {
    let message = `Request failed: ${response.status}`;
    try {
      const payload = await response.json();
      message = payload.detail ?? message;
    } catch {
      // Keep default error.
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

export default defineBackground(() => {
  const ensureContentScript = async (tabId: number) => {
    const scripting = (browser as any).scripting;
    if (!scripting?.executeScript) {
      return;
    }
    try {
      await scripting.insertCSS({
        target: { tabId },
        files: ["content-scripts/content.css"]
      });
    } catch {
      // CSS may already be injected.
    }
    try {
      await scripting.executeScript({
        target: { tabId },
        files: ["content-scripts/content.js"]
      });
    } catch {
      // Script may already be injected or blocked on restricted pages.
    }
  };

  const onToolbarClick = async (tab: any) => {
    if (!tab.id) {
      return;
    }
    await ensureContentScript(tab.id);
    browser.tabs.sendMessage(tab.id, { type: "togglePanel" }).catch(() => {
      // Receiver may be unavailable on restricted pages.
    });
  };

  // Chromium MV3 uses action; Firefox MV2-compatible builds may expose browserAction.
  if ((browser as any).action?.onClicked) {
    (browser as any).action.onClicked.addListener(onToolbarClick);
  } else if ((browser as any).browserAction?.onClicked) {
    (browser as any).browserAction.onClicked.addListener(onToolbarClick);
  }

  browser.runtime.onInstalled.addListener(async () => {
    const storage = await browser.storage.local.get(["apiBaseUrl", "tokens"]);
    if (!storage.apiBaseUrl) {
      await browser.storage.local.set({ apiBaseUrl: DEFAULT_API_BASE_URL });
    }
    if (!storage.tokens) {
      await browser.storage.local.set({ tokens: null });
    }
  });

  browser.runtime.onMessage.addListener((message: RuntimeMessage) => {
    return (async () => {
      switch (message.type) {
        case "health":
          return request("/health");
        case "register":
          return request("/auth/register", {
            method: "POST",
            body: JSON.stringify({ id: message.id, password: message.password })
          });
        case "login":
          return request("/auth/login", {
            method: "POST",
            body: JSON.stringify({ id: message.id, password: message.password })
          });
        case "createChat":
          return request("/chats", {
            method: "POST",
            headers: { Authorization: `Bearer ${message.accessToken}` }
          });
        case "listChats":
          return request("/chats", {
            headers: { Authorization: `Bearer ${message.accessToken}` }
          });
        case "getMessages":
          return request(`/chats/${message.chatId}/messages`, {
            headers: { Authorization: `Bearer ${message.accessToken}` }
          });
        case "sendMessage":
          return request(`/chats/${message.chatId}/messages`, {
            method: "POST",
            headers: { Authorization: `Bearer ${message.accessToken}` },
            body: JSON.stringify({ content: message.content, attachments: [] })
          });
        case "saveTokens":
          await browser.storage.local.set({ tokens: message.tokens });
          return { ok: true };
        default:
          return { ok: false };
      }
    })();
  });
});
