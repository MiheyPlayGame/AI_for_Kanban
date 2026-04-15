import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

const DEFAULT_API_BASE_URL = "http://localhost:8000";

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

type RuntimeResponse = {
  ok?: boolean;
  __error?: string;
  [key: string]: any;
};

function normalizeApiBaseUrl(rawValue?: string) {
  if (!rawValue || typeof rawValue !== "string") {
    return DEFAULT_API_BASE_URL;
  }

  // Fix common typo like localhost//8000 and trim trailing slash.
  const prepared = rawValue
    .replace("localhost//", "localhost:")
    .replace(/\/+$/, "")
    .trim();

  if (!prepared) {
    return DEFAULT_API_BASE_URL;
  }

  try {
    const withProtocol = prepared.includes("://") ? prepared : `http://${prepared}`;
    const url = new URL(withProtocol);
    return `${url.protocol}//${url.host}`;
  } catch {
    return DEFAULT_API_BASE_URL;
  }
}

async function getApiBaseUrl() {
  const config = await browser.storage.local.get("apiBaseUrl");
  return normalizeApiBaseUrl(config.apiBaseUrl as string | undefined);
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
    const normalizedApiBaseUrl = normalizeApiBaseUrl(storage.apiBaseUrl as string | undefined);
    if (storage.apiBaseUrl !== normalizedApiBaseUrl) {
      await browser.storage.local.set({ apiBaseUrl: normalizedApiBaseUrl });
    }
    if (!storage.tokens) {
      await browser.storage.local.set({ tokens: null });
    }
  });

  browser.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
    (async () => {
      switch (message.type) {
        case "health":
          sendResponse(await request("/health"));
          return;
        case "register":
          sendResponse(
            await request("/auth/register", {
              method: "POST",
              body: JSON.stringify({ id: message.id, password: message.password })
            })
          );
          return;
        case "login":
          sendResponse(
            await request("/auth/login", {
              method: "POST",
              body: JSON.stringify({ id: message.id, password: message.password })
            })
          );
          return;
        case "createChat":
          sendResponse(
            await request("/chats", {
              method: "POST",
              headers: { Authorization: `Bearer ${message.accessToken}` }
            })
          );
          return;
        case "listChats":
          sendResponse(
            await request("/chats", {
              headers: { Authorization: `Bearer ${message.accessToken}` }
            })
          );
          return;
        case "getMessages":
          sendResponse(
            await request(`/chats/${message.chatId}/messages`, {
              headers: { Authorization: `Bearer ${message.accessToken}` }
            })
          );
          return;
        case "sendMessage":
          sendResponse(
            await request(`/chats/${message.chatId}/messages`, {
              method: "POST",
              headers: { Authorization: `Bearer ${message.accessToken}` },
              body: JSON.stringify({ content: message.content, attachments: [] })
            })
          );
          return;
        case "saveTokens":
          await browser.storage.local.set({ tokens: message.tokens });
          sendResponse({ ok: true });
          return;
        default:
          sendResponse({ ok: false });
      }
    })().catch((error: any) => {
      const payload: RuntimeResponse = { __error: error?.message || "Unknown extension runtime error." };
      sendResponse(payload);
    });

    // Required for Chromium callback-based async responses.
    return true;
  });
});
