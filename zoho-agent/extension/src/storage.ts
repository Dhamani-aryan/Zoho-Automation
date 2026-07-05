export type ExtensionSettings = {
  backendUrl: string;
  token: string;
  enabled: boolean;
};

const DEFAULT_SETTINGS: ExtensionSettings = {
  backendUrl: "http://localhost:3000",
  token: "",
  enabled: false
};

export function loadSettings(): Promise<ExtensionSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (items) => {
      resolve({
        backendUrl: typeof items.backendUrl === "string" ? items.backendUrl : DEFAULT_SETTINGS.backendUrl,
        token: typeof items.token === "string" ? items.token : DEFAULT_SETTINGS.token,
        enabled: typeof items.enabled === "boolean" ? items.enabled : DEFAULT_SETTINGS.enabled
      });
    });
  });
}

export function saveSettings(settings: ExtensionSettings): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(settings, resolve);
  });
}
