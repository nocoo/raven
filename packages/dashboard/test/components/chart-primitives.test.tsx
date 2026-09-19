// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChartTooltip, ChartTooltipRow, ChartTooltipSummary } from "@/components/dashboard/chart-primitives";
import { CodeBlock } from "@/components/code-block";

describe("dashboard display atoms", () => {
  it.each([undefined, null, "", "Requests"])("keeps tooltip content with optional title %j", (title) => {
    const { container } = render(<ChartTooltip title={title}>
      <ChartTooltipRow color="rgb(12, 34, 56)" label="Success" value={3} />
      <ChartTooltipRow label="Failure" value={0} />
      <ChartTooltipSummary label="Total" value={3} />
    </ChartTooltip>);
    expect(screen.getByText("Success")).toBeDefined();
    expect(screen.getByText("Failure")).toBeDefined();
    expect(screen.getByText("Total")).toBeDefined();
    expect(container.querySelector('[aria-hidden="true"]')).toHaveStyle({ background: "rgb(12, 34, 56)" });
    expect(container.querySelectorAll("p")).toHaveLength(title ? 1 : 0);
  });

  it.each([undefined, "custom-code"])("preserves literal code with optional class %j", (className) => {
    render(<CodeBlock code="echo fixture" {...(className === undefined ? {} : { className })} />);
    expect(screen.getByText("echo fixture").tagName).toBe("CODE");
  });
});
