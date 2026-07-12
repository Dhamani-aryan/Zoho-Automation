export const COMPOSER_INPUT_REQUIRES_APPROVAL =
  "composer input requires an approved task order or approval; propose a task order first";

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
  if (input.approvalId || input.taskOrderId) return { allowed: true as const, reason: "approved_scope" };
  if (input.toolName === "browser_input") {
    return { allowed: false as const, reason: COMPOSER_INPUT_REQUIRES_APPROVAL };
  }
  if (input.toolName === "browser_eval") {
    const code = typeof input.args?.code === "string" ? input.args.code : "";
    if (!browserEvalIsProvablyReadOnly(code)) {
      return { allowed: false as const, reason: COMPOSER_INPUT_REQUIRES_APPROVAL };
    }
  }
  return { allowed: true as const, reason: "read_only_or_ungated_tool" };
}
