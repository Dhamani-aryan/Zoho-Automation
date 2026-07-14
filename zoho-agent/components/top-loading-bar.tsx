"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

export function TopLoadingBar() {
  const pathname = usePathname();
  const firstPath = useRef(true);
  const previousPath = useRef(pathname);
  const fallbackTimer = useRef<number | null>(null);
  const finishTimer = useRef<number | null>(null);
  const [visible, setVisible] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [progress, setProgress] = useState(0);

  const clearTimers = useCallback(() => {
    if (fallbackTimer.current) window.clearTimeout(fallbackTimer.current);
    if (finishTimer.current) window.clearTimeout(finishTimer.current);
    fallbackTimer.current = null;
    finishTimer.current = null;
  }, []);

  const finish = useCallback(() => {
    if (fallbackTimer.current) window.clearTimeout(fallbackTimer.current);
    fallbackTimer.current = null;
    setFinishing(true);
    setProgress(100);
    if (finishTimer.current) window.clearTimeout(finishTimer.current);
    finishTimer.current = window.setTimeout(() => {
      setVisible(false);
      setFinishing(false);
      setProgress(0);
    }, 220);
  }, []);

  const start = useCallback(() => {
    clearTimers();
    setVisible(true);
    setFinishing(false);
    setProgress((current) => (current > 0 ? Math.max(current, 18) : 10));

    fallbackTimer.current = window.setTimeout(() => {
      finish();
    }, 5000);
  }, [clearTimers, finish]);

  useEffect(() => {
    if (!visible || finishing) return;

    const interval = window.setInterval(() => {
      setProgress((current) => {
        if (current >= 88) return current;
        return current + Math.max(2, (88 - current) * 0.12);
      });
    }, 180);

    return () => window.clearInterval(interval);
  }, [finishing, visible]);

  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      previousPath.current = pathname;
      return;
    }

    if (previousPath.current === pathname) return;
    previousPath.current = pathname;

    const timer = window.setTimeout(() => {
      finish();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [finish, pathname]);

  useEffect(() => {
    function shouldIgnoreLink(event: MouseEvent, anchor: HTMLAnchorElement) {
      if (event.defaultPrevented || event.button !== 0) return true;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return true;
      if (anchor.target && anchor.target !== "_self") return true;
      if (anchor.hasAttribute("download")) return true;

      const nextUrl = new URL(anchor.href);
      if (nextUrl.origin !== window.location.origin) return true;
      if (nextUrl.href === window.location.href) return true;

      return false;
    }

    function handleClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (shouldIgnoreLink(event, anchor)) return;

      start();
    }

    function handleSubmit(event: SubmitEvent) {
      const target = event.target;
      if (!(target instanceof HTMLFormElement)) return;
      if (target.method.toLowerCase() === "dialog") return;

      start();
    }

    function handlePopState() {
      start();
    }

    document.addEventListener("click", handleClick, true);
    document.addEventListener("submit", handleSubmit, true);
    window.addEventListener("popstate", handlePopState);

    return () => {
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("submit", handleSubmit, true);
      window.removeEventListener("popstate", handlePopState);
      clearTimers();
    };
  }, [clearTimers, start]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-[9999] h-1 overflow-hidden bg-transparent"
    >
      <div
        className="h-full origin-left shadow-[0_0_14px_rgba(19,121,91,0.45)] transition-[transform,opacity] duration-200 ease-out"
        style={{
          background: "linear-gradient(90deg, #13795b 0%, #1f9f76 60%, #70d7a7 100%)",
          opacity: visible ? 1 : 0,
          transform: `scaleX(${progress / 100})`
        }}
      />
    </div>
  );
}

