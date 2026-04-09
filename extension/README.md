# AI Kanban Extension (WXT)

This folder contains a cross-browser web extension scaffold (Chromium + Firefox) that ports the current AI chat/home UI into a content-script panel.

## What is included

- WXT-based extension setup
- React content-script panel injected on web pages
- Background worker that talks to existing backend endpoints:
  - `GET /health`
  - `POST /auth/register`
  - `POST /auth/login`
  - `GET /chats`
  - `POST /chats`
  - `GET /chats/{chat_id}/messages`
  - `POST /chats/{chat_id}/messages`
- Backend URL default: `http://127.0.0.1:8000`

## Install

```bash
cd extension
npm install
```

## Run in Chromium

```bash
npm run dev
```

Then:
1. Open `chrome://extensions` (or Edge/Brave equivalent)
2. Enable Developer mode
3. Load unpacked extension from `.output/chrome-mv3`
4. Open any page (or Jira/Trello/Notion) and use the injected panel

## Run in Firefox

```bash
npm run dev:firefox
```

Then:
1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `.output/firefox-mv2/manifest.json`
4. Open a target page and verify panel behavior

## Build artifacts

```bash
npm run build
npm run build:firefox
```

Zip packages:

```bash
npm run zip
npm run zip:firefox
```

## Backend integration notes

- Start backend from the `backend` branch on `http://127.0.0.1:8000`
- Extension checks `/health` every 5s
- Auth is prompted by the panel buttons and backend tokens are stored in extension local storage
