import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

const DEFAULT_API_BASE_URL = "http://localhost:8000";

function normalizeApiBaseUrl(input?: string) {
  const trimmed = (input ?? "").trim();
  const fallback = DEFAULT_API_BASE_URL;
  const withValue = trimmed || fallback;
  return withValue.replace(/\/+$/, "");
}

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
  | { type: "saveTokens"; tokens: Tokens | null }
  | { type: "loadSession" }
  | { type: "saveSession"; session: { tokens?: Tokens | null; activeChatId?: string | null; panelMode?: "home" | "chat" } }
  | { type: "connectApi"; accessToken: string; apiKey: string; databaseId: string }
  | { type: "decomposeTask"; accessToken: string; chatId: string; taskTitle: string };

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
    const storage = await browser.storage.local.get(["apiBaseUrl", "tokens", "activeChatId", "panelMode"]);
    if (!storage.apiBaseUrl) {
      await browser.storage.local.set({ apiBaseUrl: DEFAULT_API_BASE_URL });
    }
    if (!storage.tokens) {
      await browser.storage.local.set({ tokens: null });
    }
    if (!("activeChatId" in storage)) {
      await browser.storage.local.set({ activeChatId: null });
    }
    if (!storage.panelMode) {
      await browser.storage.local.set({ panelMode: "home" });
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
          return { ok: true };
        case "loadSession": {
          const storage = await browser.storage.local.get(["tokens", "activeChatId", "panelMode"]);
          return {
            tokens: (storage.tokens as Tokens | null) || null,
            activeChatId: (storage.activeChatId as string | null) || null,
            panelMode: storage.panelMode === "chat" ? "chat" : "home"
          };
        }
        case "saveSession":
          await browser.storage.local.set({
            ...(message.session.tokens !== undefined ? { tokens: message.session.tokens } : {}),
            ...(message.session.activeChatId !== undefined ? { activeChatId: message.session.activeChatId } : {}),
            ...(message.session.panelMode !== undefined ? { panelMode: message.session.panelMode } : {})
          });
          return { ok: true };
        case "connectApi":
          return request("/integrations/notion/connect", {
            method: "POST",
            headers: { Authorization: `Bearer ${message.accessToken}` },
            body: JSON.stringify({ api_key: message.apiKey, database_id: message.databaseId })
          });
        case "decomposeTask":
          return request("/tasks/decompose-from-notion", {
            method: "POST",
            headers: { Authorization: `Bearer ${message.accessToken}` },
            body: JSON.stringify({ chat_id: message.chatId, task_title: message.taskTitle })
          });
        default:
          sendResponse({ ok: false });
      }
    })().catch((error: any) => {
      const payload = { __error: error?.message || "Unknown extension runtime error." };
      sendResponse(payload);
    });

    // Required for Chromium callback-based async responses.
    return true;
  });
});
