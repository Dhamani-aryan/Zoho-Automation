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
}
