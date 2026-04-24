import { browser } from "wxt/browser";

export type Tokens = {
  access_token: string;
  refresh_token: string;
  token_type: string;
};

export type PanelMode = "home" | "chat" | "settings";

export type StoredSession = {
  tokens: Tokens | null;
  activeChatId: string | null;
  panelMode: PanelMode;
};

export type SummaryResponse = {
  summary: string;
  source: string;
};

export type SemanticSearchResponse = {
  query: string;
  notion_matches: Array<{ score: number; item: { title: string; url?: string | null } }>;
  chat_matches: Array<{ score: number; message: { role: string; content: string } }>;
  information_matches: Array<{ score: number; source_label: string; snippet: string }>;
};

export type NotionDatabaseEntry = {
  database_id: string;
  title: string;
  is_default: boolean;
};

async function sendRuntimeMessage<T = any>(payload: Record<string, any>): Promise<T> {
  const response = await browser.runtime.sendMessage(payload);
  if (response?.__error) {
    throw new Error(response.__error);
  }
  return response as T;
}

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
  return sendRuntimeMessage({ type: "saveTokens", tokens });
}

export function loadSession(): Promise<StoredSession> {
  return sendRuntimeMessage({ type: "loadSession" });
}

export function saveSession(session: Partial<StoredSession>) {
  return sendRuntimeMessage({ type: "saveSession", session });
}

export function connectApi(accessToken: string, apiKey: string, databaseId?: string) {
  return sendRuntimeMessage({
    type: "connectApi",
    accessToken,
    apiKey,
    ...(databaseId ? { databaseId } : {})
  });
}

export function runDecompose(accessToken: string, chatId: string, taskTitle: string) {
  return sendRuntimeMessage({
    type: "decomposeTask",
    accessToken,
    chatId,
    taskTitle
  });
}

export function summarizeText(accessToken: string, text: string) {
  return sendRuntimeMessage<SummaryResponse>({
    type: "summarizeText",
    accessToken,
    text
  });
}

export function findInText(accessToken: string, query: string, chatId?: string | null) {
  return sendRuntimeMessage<SemanticSearchResponse>({
    type: "findInText",
    accessToken,
    query,
    ...(chatId ? { chatId } : {})
  });
}

export function listNotionDatabases(accessToken: string) {
  return sendRuntimeMessage<{ items: NotionDatabaseEntry[] }>({
    type: "listNotionDatabases",
    accessToken
  });
}
