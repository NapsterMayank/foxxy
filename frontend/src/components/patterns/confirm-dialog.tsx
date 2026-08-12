'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { cx } from '@/lib/utils/cx';

/**
 * ===========================================================================
 * CONFIRMATION FOR AN ACTION THAT CANNOT BE TAKEN BACK — plan §4: "revoke
 * link, cancel subscription".
 *
 * Both of those are exactly the shape this exists for: a parent revoking access
 * to their child's data, and somebody ending the thing they are paying for.
 * Neither has an undo, and both are one tap away from an ordinary screen.
 *
 * THREE DECISIONS, EACH THE OPPOSITE OF THE COMFORTABLE DEFAULT.
 *
 *  1. THE CANCEL BUTTON IS FOCUSED FIRST, not the confirm. `Dialog` focuses the
 *     first focusable element, and cancel is rendered first — so Enter on a
 *     dialog somebody has not read yet does the harmless thing. On mobile,
 *     `flex-col-reverse` still puts confirm at the bottom where the thumb is,
 *     so the safe DOM order costs nothing visually.
 *
 *  2. THE CONFIRM BUTTON IS `secondary`, not a red primary. A red button is a
 *     dare; the wording carries the weight instead. §9.1's "no harsh red" is
 *     about a child's answer, but the same reasoning applies to a parent making
 *     a considered decision — alarm colour rushes people.
 *
 *  3. IT DISABLES ITSELF WHILE THE ACTION RUNS. A revoke that takes a second on
 *     a slow connection gets pressed twice, and the second press hits an API
 *     that has already succeeded — which returns 404 or 409 and renders as "it
 *     did not work" for an action that did.
 * ===========================================================================
 */

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  /** What will happen, in the user's words. Not "are you sure?". */
  readonly description: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  /** May be async; the dialog stays disabled until it settles. */
  readonly onConfirm: () => void | Promise<void>;
  readonly onCancel: () => void;
  /**
   * Where a rejected `onConfirm` goes.
   *
   * ==========================================================================
   * WITHOUT THIS, A FAILING CONFIRM WAS AN UNHANDLED PROMISE REJECTION.
   *
   * The handler is invoked from a click, so nothing is awaiting it: a rejection
   * escaped the component entirely, surfacing as a console error in the browser
   * and as noise in whatever collects them — while the user saw a dialog that
   * simply re-enabled itself with no explanation. Caught by the test suite
   * refusing to pass with an unhandled rejection in it.
   *
   * OPTIONAL, and swallowed when absent, DELIBERATELY. The intended integration
   * is a TanStack mutation, whose own error state already renders the message
   * — re-throwing there would report the same failure twice, once as a message
   * and once as a crash. A caller with no error surface of its own passes this.
   * ==========================================================================
   */
  readonly onError?: (error: unknown) => void;
  readonly className?: string;
}

export function ConfirmDialog({
  cancelLabel,
  className,
  confirmLabel,
  description,
  onCancel,
  onConfirm,
  onError,
  open,
  title,
}: ConfirmDialogProps) {
  const [running, setRunning] = useState(false);

  const confirm = async (): Promise<void> => {
    if (running) return;
    setRunning(true);
    try {
      await onConfirm();
    } catch (error) {
      // See `onError`. Never rethrown: nothing is awaiting this call, so a
      // rethrow is an unhandled rejection in the user's browser.
      onError?.(error);
    } finally {
      /*
       * Cleared even on failure. A dialog left permanently disabled after an
       * error is a dead end: the user can neither retry nor tell whether the
       * action happened.
       */
      setRunning(false);
    }
  };

  return (
    <Dialog
      className={cx(className)}
      footer={
        <>
          {/* First in the DOM, so it takes initial focus. See the header. */}
          <Button disabled={running} onClick={onCancel} variant="quiet">
            {cancelLabel}
          </Button>
          <Button
            disabled={running}
            onClick={() => {
              void confirm();
            }}
            variant="secondary"
          >
            {confirmLabel}
          </Button>
        </>
      }
      onClose={running ? () => undefined : onCancel}
      open={open}
      title={title}
    >
      {description}
    </Dialog>
  );
}
