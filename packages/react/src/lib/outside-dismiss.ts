/**
 * Outside-interaction policy shared by `DialogContent` and `SheetContent`.
 *
 * Radix dismisses an overlay surface when an outside interaction is not
 * default-prevented. That loses whatever the user typed, and a stray click on
 * the page behind a form is easy to make. So the default here is the opposite
 * of Radix's: an outside interaction keeps the surface open. Escape and the
 * close button are unaffected — they still close.
 *
 * A surface with nothing to lose (a confirmation, a picker, a read-only panel)
 * opts back in with `dismissOnOutsideClick`.
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
 * Whether an outside interaction should close the surface.
 *
 * Pure so the decision is testable without a DOM: the caller does the element
 * lookup and passes the answer in.
 */
export const dismissesOnOutsideInteraction = (input: {
  readonly dismissOnOutsideClick: boolean;
  readonly insidePortaledPopup: boolean;
}): boolean => input.dismissOnOutsideClick && !input.insidePortaledPopup;

/** The shape Radix hands to `onInteractOutside` and `onPointerDownOutside`. */
type OutsideInteractionEvent = {
  readonly detail: { readonly originalEvent: { readonly target: unknown } };
  readonly preventDefault: () => void;
};

/** Apply the policy to a Radix outside-interaction event. */
export const applyOutsideDismissPolicy = (
  event: OutsideInteractionEvent,
  dismissOnOutsideClick: boolean,
): void => {
  const dismisses = dismissesOnOutsideInteraction({
    dismissOnOutsideClick,
    insidePortaledPopup: isInsidePortaledPopup(event.detail.originalEvent.target),
  });
  if (!dismisses) event.preventDefault();
};
