import { defineStore } from "pinia";

try {
  const legacy = localStorage.getItem("toonflow.developer");
  if (legacy !== null) {
    if (localStorage.getItem("dramaai.developer") === null) {
      localStorage.setItem("dramaai.developer", legacy);
    }
    localStorage.removeItem("toonflow.developer");
  }
} catch {}

export const useDeveloperStore = defineStore("developer", {
  state: () => ({ developerConfirmed: false }),
  persist: { key: "dramaai.developer", storage: localStorage },
});
