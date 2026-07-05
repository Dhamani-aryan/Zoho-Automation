import { handshake } from "./api";
import { loadSettings, saveSettings, type ExtensionSettings } from "./storage";

function input(id: string) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`Missing #${id}`);
  return element;
}

function text(id: string) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing #${id}`);
  return element;
}

const backendUrl = input("backendUrl");
const token = input("token");
const enabled = input("enabled");
const message = text("message");
const status = text("status");

function readForm(): ExtensionSettings {
  return {
    backendUrl: backendUrl.value.trim() || "http://localhost:3000",
    token: token.value.trim(),
    enabled: enabled.checked
  };
}

function writeForm(settings: ExtensionSettings) {
  backendUrl.value = settings.backendUrl;
  token.value = settings.token;
  enabled.checked = settings.enabled;
}

async function save() {
  await saveSettings(readForm());
  message.textContent = "Saved.";
}

async function runHandshake() {
  await save();
  const result = await handshake(readForm());
  status.textContent = JSON.stringify(result, null, 2);
  message.textContent = `Connected as ${result.user.name}.`;
}

async function dryClaimOnce() {
  await save();
  const response = (await chrome.runtime.sendMessage({ action: "dryPollOnce" })) as {
    ok?: boolean;
    error?: string;
  };
  status.textContent = JSON.stringify(response, null, 2);
  message.textContent = response?.ok ? "Dry claim complete." : "Dry claim failed.";
}

document.getElementById("save")?.addEventListener("click", () => {
  save().catch((error) => {
    message.textContent = error instanceof Error ? error.message : "Save failed.";
  });
});

document.getElementById("handshake")?.addEventListener("click", () => {
  runHandshake().catch((error) => {
    message.textContent = error instanceof Error ? error.message : "Handshake failed.";
  });
});

document.getElementById("runOnce")?.addEventListener("click", () => {
  dryClaimOnce().catch((error) => {
    message.textContent = error instanceof Error ? error.message : "Dry claim failed.";
  });
});

loadSettings()
  .then(writeForm)
  .catch((error) => {
    message.textContent = error instanceof Error ? error.message : "Could not load settings.";
  });
