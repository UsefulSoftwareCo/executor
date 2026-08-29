import { describe, expect, it } from "@effect/vitest";

import {
  applyOutsideDismissPolicy,
  containsFormField,
  dismissesOnOutsideInteraction,
  FORM_FIELD_SELECTOR,
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
  it("keeps a surface with a form field open by default", () => {
    expect(
      dismissesOnOutsideInteraction({
        dismissOnOutsideClick: undefined,
        insidePortaledPopup: false,
        containsFormField: true,
      }),
    ).toBe(false);
  });

  it("closes a surface with no form field by default", () => {
    expect(
      dismissesOnOutsideInteraction({
        dismissOnOutsideClick: undefined,
        insidePortaledPopup: false,
        containsFormField: false,
      }),
    ).toBe(true);
  });

  it("closes a form surface that explicitly opts in", () => {
    expect(
      dismissesOnOutsideInteraction({
        dismissOnOutsideClick: true,
        insidePortaledPopup: false,
        containsFormField: true,
      }),
    ).toBe(true);
  });

  it("keeps a field-free surface open when it explicitly opts out", () => {
    expect(
      dismissesOnOutsideInteraction({
        dismissOnOutsideClick: false,
        insidePortaledPopup: false,
        containsFormField: false,
      }),
    ).toBe(false);
  });

  it("never closes on a click inside a portaled popup, even when it opts in", () => {
    // A combobox or select renders its list outside the surface, so choosing an
    // option arrives as an outside interaction. Dismissing there would drop the
    // selection before it lands.
    expect(
      dismissesOnOutsideInteraction({
        dismissOnOutsideClick: true,
        insidePortaledPopup: true,
        containsFormField: false,
      }),
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

/** A stand-in for the surface node, recording what it was asked for. */
const surfaceStub = (options: { readonly hasFormField: boolean }) => {
  const queries: Array<string> = [];
  return {
    surface: {
      querySelector: (selectors: string) => {
        queries.push(selectors);
        return options.hasFormField ? { nodeName: "INPUT" } : null;
      },
    },
    queries: () => queries,
  };
};

describe("applyOutsideDismissPolicy", () => {
  it("blocks a plain outside click while the surface holds a form field", () => {
    const outside = outsideEvent();
    const stub = surfaceStub({ hasFormField: true });
    applyOutsideDismissPolicy(outside.event, undefined, stub.surface);
    expect(outside.prevented()).toBe(true);
    expect(stub.queries()).toEqual([FORM_FIELD_SELECTOR]);
  });

  it("lets a plain outside click through when the surface has no form field", () => {
    const outside = outsideEvent();
    const stub = surfaceStub({ hasFormField: false });
    applyOutsideDismissPolicy(outside.event, undefined, stub.surface);
    expect(outside.prevented()).toBe(false);
  });

  it("lets an outside click through when a form surface opts in", () => {
    const outside = outsideEvent();
    const stub = surfaceStub({ hasFormField: true });
    applyOutsideDismissPolicy(outside.event, true, stub.surface);
    expect(outside.prevented()).toBe(false);
  });

  it("blocks an outside click when a field-free surface opts out", () => {
    const outside = outsideEvent();
    const stub = surfaceStub({ hasFormField: false });
    applyOutsideDismissPolicy(outside.event, false, stub.surface);
    expect(outside.prevented()).toBe(true);
  });

  it("blocks the click when the surface node is not mounted yet", () => {
    // No node means no way to prove the surface is safe to discard, so the
    // policy falls back to keeping it open.
    const outside = outsideEvent();
    applyOutsideDismissPolicy(outside.event, undefined, null);
    expect(outside.prevented()).toBe(true);
  });
});

describe("containsFormField", () => {
  it("reports a field when the surface query matches", () => {
    expect(containsFormField(surfaceStub({ hasFormField: true }).surface)).toBe(true);
  });

  it("reports no field for a missing surface", () => {
    expect(containsFormField(null)).toBe(false);
  });
});

describe("FORM_FIELD_SELECTOR", () => {
  it("covers native fields, contenteditable, and ARIA widget roles", () => {
    // base-ui and Radix render select/combobox triggers, checkboxes, switches,
    // radios, and sliders as buttons whose only signature is the ARIA role, so
    // every one of these must stay in the selector or a dialog holding it
    // starts dismissing on stray clicks.
    for (const part of [
      "input",
      "textarea",
      "select",
      "[contenteditable]:not([contenteditable='false'])",
      "[role='checkbox']",
      "[role='combobox']",
      "[role='listbox']",
      "[role='radio']",
      "[role='searchbox']",
      "[role='slider']",
      "[role='spinbutton']",
      "[role='switch']",
      "[role='textbox']",
    ]) {
      expect(FORM_FIELD_SELECTOR.split(",")).toContain(part);
    }
  });
});

describe("PORTALED_POPUP_SELECTOR", () => {
  it("covers both popup slots that portal out of a surface", () => {
    expect(PORTALED_POPUP_SELECTOR).toBe(
      "[data-slot='combobox-content'],[data-slot='select-content']",
    );
  });
});
