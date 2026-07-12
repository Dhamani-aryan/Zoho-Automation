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
