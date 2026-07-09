export type ExtensionSettings = {
  backendUrl: string;
  token: string;
  enabled: boolean;
  lastJobStatus: string;
  jobHistory: string[];
};

const DEFAULT_SETTINGS: ExtensionSettings = {
  backendUrl: "http://localhost:3000",
  token: "",
  enabled: false,
  lastJobStatus: "No agent jobs yet.",
  jobHistory: []
};

export function loadSettings(): Promise<ExtensionSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (items) => {
      resolve({
        backendUrl: typeof items.backendUrl === "string" ? items.backendUrl : DEFAULT_SETTINGS.backendUrl,
        token: typeof items.token === "string" ? items.token : DEFAULT_SETTINGS.token,
        enabled: typeof items.enabled === "boolean" ? items.enabled : DEFAULT_SETTINGS.enabled,
        lastJobStatus: typeof items.lastJobStatus === "string" ? items.lastJobStatus : DEFAULT_SETTINGS.lastJobStatus,
        jobHistory: Array.isArray(items.jobHistory)
          ? items.jobHistory.filter((item): item is string => typeof item === "string").slice(0, 10)
          : DEFAULT_SETTINGS.jobHistory
      });
    });
  });
}

export function saveSettings(settings: ExtensionSettings): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(settings, resolve);
  });
}

export function saveLastJobStatus(lastJobStatus: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (items) => {
      const existing = Array.isArray(items.jobHistory)
        ? items.jobHistory.filter((item): item is string => typeof item === "string")
        : [];
      const stamp = new Date().toLocaleString();
      chrome.storage.local.set(
        {
          lastJobStatus,
          jobHistory: [`${stamp} - ${lastJobStatus}`, ...existing].slice(0, 10)
        },
        resolve
      );
    });
  });
}
