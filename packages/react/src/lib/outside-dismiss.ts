/**
 * Outside-interaction policy shared by `DialogContent` and `SheetContent`.
 *
 * Radix dismisses an overlay surface when an outside interaction is not
 * default-prevented. That loses whatever the user typed, and a stray click on
 * the page behind a form is easy to make. So by default the surface decides
 * from its own contents: while it holds a form field, an outside interaction
 * keeps it open; a surface with nothing to lose (a confirmation, a picker, a
 * read-only panel) closes. Escape and the close button are unaffected — they
 * still close.
 *
 * `dismissOnOutsideClick` overrides the detection in either direction.
 */

/** base-ui popups (combobox/select) portal their list OUTSIDE the surface, so a
 *  click on an option reads as an interaction outside it. Such a click must
 *  never dismiss, even when the surface opts in. */
export const PORTALED_POPUP_SELECTOR =
  "[data-slot='combobox-content'],[data-slot='select-content']";

/** True when the interaction started inside a popup this surface portals out. */
export const isInsidePortaledPopup = (target: unknown): boolean =>
  typeof Element !== "undefined" &&
  target instanceof Element &&
  target.closest(PORTALED_POPUP_SELECTOR) !== null;

/**
 * Controls whose presence means an outside click could discard user state.
 *
 * Tag selectors alone are not enough: base-ui and Radix render select and
 * combobox triggers, checkboxes, switches, radios, and sliders as `button`
 * elements carrying only an ARIA role, so the roles have to be matched too.
 */
export const FORM_FIELD_SELECTOR = [
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
].join(",");

/** The one Element method the policy needs, so tests can stub it without a DOM. */
type SurfaceLike = { querySelector(selectors: string): unknown };

/** True when the surface currently holds a form field. */
export const containsFormField = (surface: SurfaceLike | null): boolean =>
  surface !== null && surface.querySelector(FORM_FIELD_SELECTOR) !== null;

/**
 * Whether an outside interaction should close the surface.
 *
 * Pure so the decision is testable without a DOM: the caller does the element
 * lookups and passes the answers in. `dismissOnOutsideClick` left undefined
 * means "decide from the contents".
 */
export const dismissesOnOutsideInteraction = (input: {
  readonly dismissOnOutsideClick: boolean | undefined;
  readonly insidePortaledPopup: boolean;
  readonly containsFormField: boolean;
}): boolean =>
  !input.insidePortaledPopup && (input.dismissOnOutsideClick ?? !input.containsFormField);

/** The shape Radix hands to `onInteractOutside` and `onPointerDownOutside`. */
type OutsideInteractionEvent = {
  readonly detail: { readonly originalEvent: { readonly target: unknown } };
  readonly preventDefault: () => void;
};

/** Apply the policy to a Radix outside-interaction event. Radix dispatches the
 *  event on the OUTSIDE element, so the surface node must be passed in. A
 *  missing node cannot prove the surface is safe to discard, so it stays open. */
export const applyOutsideDismissPolicy = (
  event: OutsideInteractionEvent,
  dismissOnOutsideClick: boolean | undefined,
  surface: SurfaceLike | null,
): void => {
  const dismisses =
    surface !== null &&
    dismissesOnOutsideInteraction({
      dismissOnOutsideClick,
      insidePortaledPopup: isInsidePortaledPopup(event.detail.originalEvent.target),
      containsFormField: containsFormField(surface),
    });
  if (!dismisses) event.preventDefault();
};
