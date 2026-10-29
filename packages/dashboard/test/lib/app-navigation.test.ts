// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAppPathname, useAppSearchParams } from "@/lib/app-navigation";

const navigation = vi.hoisted(() => ({
  pathname: "/requests" as string | null,
  searchParams: new URLSearchParams("sort=latency_ms") as URLSearchParams | null,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => navigation.searchParams,
}));

describe("useAppPathname", () => {
  it("falls back when pathname is unavailable", () => {
    navigation.pathname = null;
    const { result } = renderHook(() => useAppPathname());
    expect(result.current).toBe("/");
  });
});

describe("useAppSearchParams", () => {
  it("falls back to an empty query when search params are unavailable", () => {
    navigation.searchParams = null;
    const { result } = renderHook(() => useAppSearchParams());
    expect(result.current.toString()).toBe("");
  });

  it("copies current search params into a mutable snapshot", () => {
    navigation.searchParams = new URLSearchParams("sort=latency_ms&order=asc");
    const { result } = renderHook(() => useAppSearchParams());
    expect(result.current.get("sort")).toBe("latency_ms");
    expect(result.current.get("order")).toBe("asc");
  });
});
