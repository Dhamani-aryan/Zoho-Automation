export type UiPageResult =
  | { ok: true; result: unknown }
  | { ok: false; error_message: string; error_code?: string; result?: unknown };

export async function zohoUiPageRunner(job: { tool_name: string; args: Record<string, unknown> }): Promise<UiPageResult> {
  const step = (job.args.step ?? {}) as Record<string, unknown>;
  const type = String(step.type ?? "");

  function textOf(element: Element) {
    return (element.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  function valueOf(element: Element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      return element.value;
    }
    return textOf(element);
  }

  function findByText(text: string) {
    const wanted = text.trim().toLowerCase();
    const all = [...document.querySelectorAll("button,a,input,textarea,[role='button'],span,div")];
    return all.find((element) => textOf(element).toLowerCase().includes(wanted)) ?? null;
  }

  function target() {
    const selector = typeof step.selector === "string" ? step.selector : "";
    const text = typeof step.text === "string" ? step.text : "";
    if (selector) return document.querySelector(selector);
    if (text) return findByText(text);
    return null;
  }

  async function waitForTarget(timeoutMs: number) {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 250), 10000);
    while (Date.now() <= deadline) {
      const element = target();
      if (element) return element;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  function mouseClick(element: Element) {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    for (const eventType of ["mouseover", "mousedown", "mouseup", "click"]) {
      element.dispatchEvent(
        new MouseEvent(eventType, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y
        })
      );
    }
  }

  function pressKey(key: string) {
    const active = document.activeElement ?? document.body;
    for (const eventType of ["keydown", "keyup"]) {
      active.dispatchEvent(new KeyboardEvent(eventType, { key, bubbles: true, cancelable: true }));
    }
  }

  function setNativeValue(element: Element, value: string) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const proto = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter?.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (element instanceof HTMLElement) {
      element.textContent = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  try {
    if (type === "wait_for") {
      const element = await waitForTarget(Number(step.timeout_ms ?? 5000));
      if (!element) return { ok: false, error_message: "Timed out waiting for UI target." };
      return { ok: true, result: { observed: valueOf(element) } };
    }
    if (type === "click") {
      const element = await waitForTarget(5000);
      if (!element) return { ok: false, error_message: "UI click target was not found." };
      mouseClick(element);
      return { ok: true, result: { observed: valueOf(element) } };
    }
    if (type === "fill_field") {
      const element = await waitForTarget(5000);
      if (!element) return { ok: false, error_message: "UI field was not found." };
      setNativeValue(element, String(step.value ?? ""));
      if (step.press_enter === true) pressKey("Enter");
      return { ok: true, result: { observed: valueOf(element) } };
    }
    if (type === "read_field") {
      const element = await waitForTarget(5000);
      if (!element) return { ok: false, error_message: "UI field was not found." };
      return { ok: true, result: { observed: valueOf(element) } };
    }
    if (type === "press_key") {
      pressKey(String(step.key ?? ""));
      return { ok: true, result: { observed: `pressed ${String(step.key ?? "")}` } };
    }
    if (type === "confirm_text_present") {
      const text = String(step.text ?? "");
      const found = Boolean(findByText(text));
      return found
        ? { ok: true, result: { observed: text } }
        : { ok: false, error_message: `Text was not found: ${text}` };
    }
    if (type === "verify_field") {
      const element = await waitForTarget(5000);
      if (!element) return { ok: false, error_message: "UI field was not found." };
      const observed = valueOf(element);
      const expected = String(step.equals ?? "");
      return observed === expected
        ? { ok: true, result: { observed } }
        : { ok: false, error_message: `Expected "${expected}" but observed "${observed}".`, result: { observed } };
    }
    return { ok: false, error_message: `Unsupported UI step: ${type}` };
  } catch (error) {
    return { ok: false, error_message: error instanceof Error ? error.message : "UI step failed." };
  }
}
