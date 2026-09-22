// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import OverviewLoading from "@/app/loading";
import ModelsLoading from "@/app/models/loading";
import KeysLoading from "@/app/keys/loading";
import RequestsLoading from "@/app/requests/loading";
import CopilotModelsLoading from "@/app/copilot/models/loading";
import CopilotAccountLoading from "@/app/copilot/account/loading";
import SettingsLoading from "@/app/settings/loading";
import ProxyLoading from "@/app/settings/proxy/loading";
import ServerToolsLoading from "@/app/settings/server-tools/loading";
import UpstreamsLoading from "@/app/routing/upstreams/loading";
import RoutingRulesLoading from "@/app/routing/rules/loading";
import ConnectLoading from "@/app/connect/loading";
import LoginLoading from "@/app/login/loading";

describe("route loading accessibility", () => {
  it.each([
    ["Overview", OverviewLoading],
    ["Models", ModelsLoading],
    ["API Keys", KeysLoading],
    ["Requests", RequestsLoading],
    ["Models", CopilotModelsLoading],
    ["Account", CopilotAccountLoading],
    ["General", SettingsLoading],
    ["Proxy", ProxyLoading],
    ["Server Tools", ServerToolsLoading],
    ["Upstreams", UpstreamsLoading],
    ["Routing Rules", RoutingRulesLoading],
    ["Connect", ConnectLoading],
    ["Sign in", LoginLoading],
  ] as const)("announces %s without exposing placeholder controls", (title, Loading) => {
    const { container } = render(<Loading />);
    expect(screen.getByRole("status", { name: `Loading ${title}` })).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector("a, button, input, select, textarea, [tabindex]")).toBeNull();
    expect(container.querySelector("nav, main")).toBeNull();
  });
});
