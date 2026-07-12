export const SEND_NOW_BLOCKED_MESSAGE = "send-now is blocked; schedule instead";

export function looksLikeSendNowEndpoint(value: string) {
  return [
    /\/actions\/[^/?#]*send/i,
    /\/send(?:mail|_mail|now|_now)?\b/i
  ].some((pattern) => pattern.test(value));
}

export function isModifierEnterKey(key: string) {
  return /^(?:ctrl|control|cmd|command|meta)\+enter$/i.test(key.trim());
}

export function isPlainEnterKey(key: string) {
  return /^enter$/i.test(key.trim());
}

function normalizedLabel(value: unknown) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export type SendControlLabelInput = {
  text?: unknown;
  value?: unknown;
  ariaLabel?: unknown;
  title?: unknown;
  role?: unknown;
};

export function sendControlAccessibleNames(input: SendControlLabelInput) {
  return [input.ariaLabel, input.value, input.title, input.text].map(normalizedLabel).filter(Boolean);
}

export function isScheduleControl(input: SendControlLabelInput) {
  return sendControlAccessibleNames(input).some((name) => name === "schedule" || name === "schedule & close");
}

export function isSendNowControl(input: SendControlLabelInput) {
  if (isScheduleControl(input)) return false;
  const role = normalizedLabel(input.role);
  const buttonish = !role || role === "button" || role === "menuitem" || role === "link";
  if (!buttonish) return false;
  return sendControlAccessibleNames(input).some((name) => name === "send" || name === "send email" || name === "send now" || name === "send mail");
}

export type ComposerScopedSendControlInput = SendControlLabelInput & {
  insideComposerSurface?: unknown;
};

export function isComposerScopedSendNowControl(input: ComposerScopedSendControlInput) {
  return input.insideComposerSurface === true && isSendNowControl(input);
}
