import { describe, expect, it } from "@effect/vitest";

import {
  applyOutsideDismissPolicy,
  dismissesOnOutsideInteraction,
  PORTALED_POPUP_SELECTOR,
} from "./outside-dismiss";

/**
 * The property under test: a dialog or sheet keeps what the user typed.
 *
 * Radix closes an overlay surface whenever an outside interaction reaches it
 * un-prevented, so "does not dismiss" is the thing that has to be asserted, not
 * assumed. Escape is Radix's own `onEscapeKeyDown` path and never passes
 * through here, which is why no case below can close a surface with a key.
 */
describe("dismissesOnOutsideInteraction", () => {
  it("keeps the surface open by default", () => {
    expect(
      dismissesOnOutsideInteraction({
        dismissOnOutsideClick: false,
        insidePortaledPopup: false,
      }),
    ).toBe(false);
  });

  it("closes the surface when it opts in", () => {
    expect(
      dismissesOnOutsideInteraction({ dismissOnOutsideClick: true, insidePortaledPopup: false }),
    ).toBe(true);
  });

  it("never closes on a click inside a portaled popup, even when it opts in", () => {
    // A combobox or select renders its list outside the surface, so choosing an
    // option arrives as an outside interaction. Dismissing there would drop the
    // selection before it lands.
    expect(
      dismissesOnOutsideInteraction({ dismissOnOutsideClick: true, insidePortaledPopup: true }),
    ).toBe(false);
  });
});

/** A stand-in for the event Radix dispatches, recording whether it was blocked. */
const outsideEvent = () => {
  let prevented = false;
  return {
    event: {
      detail: { originalEvent: { target: { nodeName: "DIV" } } },
      preventDefault: () => {
        prevented = true;
      },
    },
    prevented: () => prevented,
  };
};

describe("applyOutsideDismissPolicy", () => {
  it("blocks a plain outside click by default", () => {
    const outside = outsideEvent();
    applyOutsideDismissPolicy(outside.event, false);
    expect(outside.prevented()).toBe(true);
  });

  it("lets a plain outside click through when the surface opts in", () => {
    const outside = outsideEvent();
    applyOutsideDismissPolicy(outside.event, true);
    expect(outside.prevented()).toBe(false);
  });
});

describe("PORTALED_POPUP_SELECTOR", () => {
  it("covers both popup slots that portal out of a surface", () => {
    expect(PORTALED_POPUP_SELECTOR).toBe(
      "[data-slot='combobox-content'],[data-slot='select-content']",
    );
  });
});
