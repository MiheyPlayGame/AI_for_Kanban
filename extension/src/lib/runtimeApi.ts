export type Tokens = {
  access_token: string;
  refresh_token: string;
  token_type: string;
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
