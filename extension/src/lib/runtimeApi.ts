export type Tokens = {
  access_token: string;
  refresh_token: string;
  token_type: string;
};

export function checkHealth() {
  return browser.runtime.sendMessage({ type: "health" });
}

export function register(id: string, password: string) {
  return browser.runtime.sendMessage({ type: "register", id, password });
}

export function login(id: string, password: string) {
  return browser.runtime.sendMessage({ type: "login", id, password });
}

export function createChat(accessToken: string) {
  return browser.runtime.sendMessage({ type: "createChat", accessToken });
}

export function listChats(accessToken: string) {
  return browser.runtime.sendMessage({ type: "listChats", accessToken });
}

export function getMessages(accessToken: string, chatId: string) {
  return browser.runtime.sendMessage({ type: "getMessages", accessToken, chatId });
}

export function sendMessage(accessToken: string, chatId: string, content: string) {
  return browser.runtime.sendMessage({ type: "sendMessage", accessToken, chatId, content });
}

export function saveTokens(tokens: Tokens | null) {
  return browser.runtime.sendMessage({ type: "saveTokens", tokens });
}
