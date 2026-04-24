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
  | {
      type: "saveSession";
      session: { tokens?: Tokens | null; activeChatId?: string | null; panelMode?: "home" | "chat" | "settings" };
    }
  | { type: "connectApi"; accessToken: string; apiKey: string; databaseId?: string }
  | { type: "decomposeTask"; accessToken: string; chatId: string; taskTitle: string }
  | { type: "summarizeText"; accessToken: string; text: string }
  | { type: "findInText"; accessToken: string; query: string; chatId?: string }
  | { type: "listNotionDatabases"; accessToken: string };

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
      const detail = payload?.detail;
      if (typeof detail === "string" && detail.trim()) {
        message = detail;
      } else if (Array.isArray(detail) && detail.length > 0) {
        const first = detail[0];
        if (typeof first?.msg === "string" && first.msg.trim()) {
          message = first.msg;
        } else {
          message = JSON.stringify(detail);
        }
      } else if (detail && typeof detail === "object") {
        message = JSON.stringify(detail);
      }
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
      let payload: any = null;
      switch (message.type) {
        case "health":
          payload = await request("/health");
          break;
        case "register":
          payload = await request("/auth/register", {
            method: "POST",
            body: JSON.stringify({ id: message.id, password: message.password })
          });
          break;
        case "login":
          payload = await request("/auth/login", {
            method: "POST",
            body: JSON.stringify({ id: message.id, password: message.password })
          });
          break;
        case "createChat":
          payload = await request("/chats", {
            method: "POST",
            headers: { Authorization: `Bearer ${message.accessToken}` }
          });
          break;
        case "listChats":
          payload = await request("/chats", {
            headers: { Authorization: `Bearer ${message.accessToken}` }
          });
          break;
        case "getMessages":
          payload = await request(`/chats/${message.chatId}/messages`, {
            headers: { Authorization: `Bearer ${message.accessToken}` }
          });
          break;
        case "sendMessage":
          payload = await request(`/chats/${message.chatId}/messages`, {
            method: "POST",
            headers: { Authorization: `Bearer ${message.accessToken}` },
            body: JSON.stringify({ content: message.content, attachments: [] })
          });
          break;
        case "saveTokens":
          await browser.storage.local.set({ tokens: message.tokens });
          payload = { ok: true };
          break;
        case "loadSession": {
          const storage = await browser.storage.local.get(["tokens", "activeChatId", "panelMode"]);
          payload = {
            tokens: (storage.tokens as Tokens | null) || null,
            activeChatId: (storage.activeChatId as string | null) || null,
            panelMode: storage.panelMode === "chat" || storage.panelMode === "settings" ? storage.panelMode : "home"
          };
          break;
        }
        case "saveSession":
          await browser.storage.local.set({
            ...(message.session.tokens !== undefined ? { tokens: message.session.tokens } : {}),
            ...(message.session.activeChatId !== undefined ? { activeChatId: message.session.activeChatId } : {}),
            ...(message.session.panelMode !== undefined ? { panelMode: message.session.panelMode } : {})
          });
          payload = { ok: true };
          break;
        case "connectApi":
          payload = await request("/integrations/notion/connect", {
            method: "POST",
            headers: { Authorization: `Bearer ${message.accessToken}` },
            body: JSON.stringify({
              api_key: message.apiKey,
              ...(message.databaseId ? { database_id: message.databaseId } : {})
            })
          });
          break;
        case "decomposeTask":
          payload = await request("/tasks/decompose-from-notion", {
            method: "POST",
            headers: { Authorization: `Bearer ${message.accessToken}` },
            body: JSON.stringify({ chat_id: message.chatId, task_title: message.taskTitle })
          });
          break;
        case "summarizeText":
          payload = await request("/summaries", {
            method: "POST",
            headers: { Authorization: `Bearer ${message.accessToken}` },
            body: JSON.stringify({ text: message.text })
          });
          break;
        case "findInText":
          payload = await request("/search/semantic", {
            method: "POST",
            headers: { Authorization: `Bearer ${message.accessToken}` },
            body: JSON.stringify({
              query: message.query,
              ...(message.chatId ? { chat_id: message.chatId } : {})
            })
          });
          break;
        case "listNotionDatabases":
          payload = await request("/integrations/notion/databases", {
            headers: { Authorization: `Bearer ${message.accessToken}` }
          });
          break;
        default:
          payload = { ok: false };
      }
      sendResponse(payload);
    })().catch((error: any) => {
      const payload = { __error: error?.message || "Unknown extension runtime error." };
      sendResponse(payload);
    });

    // Required for Chromium callback-based async responses.
    return true;
  });
});
