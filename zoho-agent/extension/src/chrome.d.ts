declare namespace chrome {
  namespace alarms {
    type Alarm = { name: string };
    function create(name: string, alarmInfo: { periodInMinutes?: number; delayInMinutes?: number }): void;
    const onAlarm: {
      addListener(callback: (alarm: Alarm) => void): void;
    };
  }

  namespace runtime {
    function sendMessage(message: unknown): Promise<unknown>;
    const onInstalled: {
      addListener(callback: () => void): void;
    };
    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: unknown,
          sendResponse: (response?: unknown) => void
        ) => boolean | void
      ): void;
    };
  }

  namespace storage {
    const local: {
      get(keys: Record<string, unknown>, callback: (items: Record<string, unknown>) => void): void;
      set(items: Record<string, unknown>, callback?: () => void): void;
    };
  }

  namespace scripting {
    type InjectionResult = { result?: unknown };
    function executeScript<Args extends unknown[]>(injection: {
      target: { tabId: number };
      world?: "MAIN" | "ISOLATED";
      func: (...args: Args) => unknown;
      args?: Args;
    }): Promise<InjectionResult[]>;
  }

  namespace tabs {
    type TabChangeInfo = {
      status?: "loading" | "complete";
    };

    type Tab = {
      id?: number;
      url?: string;
    };

    function query(queryInfo: { url?: string | string[]; active?: boolean; currentWindow?: boolean }, callback: (tabs: Tab[]) => void): void;
    function update(tabId: number, updateProperties: { url?: string; active?: boolean }): Promise<Tab>;
    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
    function captureVisibleTab(options: { format: "png" | "jpeg" }): Promise<string>;
    const onUpdated: {
      addListener(callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void): void;
      removeListener(callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void): void;
    };
  }
}
