export const COMPOSER_INPUT_REQUIRES_APPROVAL =
  "composer input is ungated; use the composer-scoped send guard and verify by read-back";

export function browserEvalIsProvablyReadOnly(code: string) {
  const source = code.trim();
  if (!source) return false;
  return ![
    /\bfetch\s*\(/i,
    /\.click\s*\(/i,
    /\.dispatchEvent\s*\(/i,
    /\.(?:value|innerHTML|outerHTML|textContent|innerText)\s*=/i,
    /\b(?:append|appendChild|prepend|before|after|remove|replaceChildren)\s*\(/i,
    /\b(?:insertAdjacentHTML|insertAdjacentText|setAttribute|removeAttribute)\s*\(/i,
    /\b(?:localStorage|sessionStorage)\.setItem\s*\(/i,
    /\bnew\s+(?:MouseEvent|KeyboardEvent|InputEvent)\b/i
  ].some((pattern) => pattern.test(source));
}

export function composerBrowserGateDecision(input: {
  toolName: string;
  args?: Record<string, unknown> | null;
  composerDetected: boolean;
  approvalId?: string | null;
  taskOrderId?: string | null;
}) {
  if (!input.composerDetected) return { allowed: true as const, reason: "no_composer" };
  return { allowed: true as const, reason: "composer_tools_ungated" };
}
