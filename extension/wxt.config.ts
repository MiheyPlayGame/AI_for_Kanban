import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "AS.YA",
    description: "AS.YA overlay helper for Jira, Trello, Notion and similar tools.",
    permissions: ["storage", "activeTab", "scripting"],
    host_permissions: [
      "<all_urls>"
    ],
    action: {
      default_title: "AS.YA"
    }
  }
});
