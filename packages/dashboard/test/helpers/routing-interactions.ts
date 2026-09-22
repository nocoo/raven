import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

export async function selectOption(label: string, option: string) {
  const user = userEvent.setup({ delay: null });
  const trigger = screen.getByRole("combobox", { name: label });
  // jsdom retains removed focus targets; restore focus before Radix opens its portal.
  trigger.focus();
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: option }));
}
