import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(async () => {
  if (typeof document === "undefined") return;
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  cleanup();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  // jsdom 30.1 retains removed focus targets; reset focus through public DOM APIs.
  const focusTarget = document.createElement("button");
  document.body.append(focusTarget);
  focusTarget.focus();
  focusTarget.blur();
  focusTarget.remove();
});

if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = ResizeObserverStub;
}
