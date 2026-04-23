import { browser } from "wxt/browser";

export type Tokens = {
  access_token: string;
  refresh_token: string;
  token_type: string;
};

export type PanelMode = "home" | "chat";

export type StoredSession = {
  tokens: Tokens | null;
  activeChatId: string | null;
  panelMode: PanelMode;
};

export function checkHealth() {
  return sendRuntimeMessage({ type: "health" });
}

export function register(id: string, password: string) {
  return sendRuntimeMessage({ type: "register", id, password });
}

export function login(id: string, password: string) {
  return sendRuntimeMessage({ type: "login", id, password });
}

export function createChat(accessToken: string) {
  return sendRuntimeMessage({ type: "createChat", accessToken });
}

export function listChats(accessToken: string) {
  return sendRuntimeMessage({ type: "listChats", accessToken });
}

export function getMessages(accessToken: string, chatId: string) {
  return sendRuntimeMessage({ type: "getMessages", accessToken, chatId });
}

export function sendMessage(accessToken: string, chatId: string, content: string) {
  return sendRuntimeMessage({ type: "sendMessage", accessToken, chatId, content });
}

export function saveTokens(tokens: Tokens | null) {
  return browser.runtime.sendMessage({ type: "saveTokens", tokens });
}

export function loadSession(): Promise<StoredSession> {
  return browser.runtime.sendMessage({ type: "loadSession" });
}

export function saveSession(session: Partial<StoredSession>) {
  return browser.runtime.sendMessage({ type: "saveSession", session });
}

export function connectApi(accessToken: string, apiKey: string, databaseId: string) {
  return browser.runtime.sendMessage({
    type: "connectApi",
    accessToken,
    apiKey,
    databaseId
  });
}

export function runDecompose(accessToken: string, chatId: string, taskTitle: string) {
  return browser.runtime.sendMessage({
    type: "decomposeTask",
    accessToken,
    chatId,
    taskTitle
  });
}
