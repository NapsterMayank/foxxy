import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from '../dialog';

/**
 * THE DIALOG — plan §4, tier 1.
 *
 * Four behaviours, and each one fails in a way a sighted mouse user never sees:
 * focus that never enters, focus that escapes, focus that does not come back,
 * and no Escape. They are the reason this is a hand-written modal rather than
 * the native element — `showModal` does not exist in jsdom, so a native dialog
 * would leave exactly these four untested.
 */

function Harness({ onClose = () => undefined }: { onClose?: () => void }) {
  return (
    <Dialog
      footer={
        <>
          <button type="button">Cancel</button>
          <button type="button">Confirm</button>
        </>
      }
      onClose={onClose}
      open
      title="Revoke access"
    >
      <p>This cannot be undone.</p>
    </Dialog>
  );
}

describe('when closed', () => {
  it('renders nothing at all', () => {
    render(
      <Dialog onClose={() => undefined} open={false} title="Revoke access">
        <p>hidden</p>
      </Dialog>,
    );

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('hidden')).toBeNull();
  });
});

describe('when open', () => {
  it('is a modal dialog named by its title', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: 'Revoke access' });

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('This cannot be undone.')).toBeVisible();
  });

  it('moves focus into the dialog, onto the first control', () => {
    // Otherwise the keyboard user is still behind it, tabbing through content
    // they cannot see.
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('locks the page behind it', () => {
    const { unmount } = render(<Harness />);
    expect(document.body.style.overflow).toBe('hidden');

    unmount();
    // Restored, or every screen after the first dialog is unscrollable.
    expect(document.body.style.overflow).not.toBe('hidden');
  });
});

describe('the focus trap', () => {
  it('wraps forward from the last control to the first', async () => {
    render(<Harness />);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Confirm' });

    await userEvent.tab();
    expect(confirm).toHaveFocus();
    await userEvent.tab();
    expect(cancel).toHaveFocus();
  });

  it('wraps backward from the first control to the last', async () => {
    /*
     * The half implemented trap almost every hand-rolled modal ships with:
     * forward Tab is handled and Shift+Tab walks straight out of the top.
     */
    render(<Harness />);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Confirm' });

    expect(cancel).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(confirm).toHaveFocus();
  });

  it('keeps focus on the panel when there is nothing focusable inside', async () => {
    render(
      <Dialog onClose={() => undefined} open title="Just a message">
        <p>Nothing to press.</p>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveFocus();
    await userEvent.tab();
    expect(dialog).toHaveFocus();
  });
});

describe('closing', () => {
  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a click on the backdrop itself', async () => {
    const onClose = vi.fn();
    const { container } = render(<Harness onClose={onClose} />);
    const backdrop = container.ownerDocument.body.querySelector('.fixed');

    await userEvent.click(backdrop as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT close on a click that merely bubbled out of the panel', async () => {
    /*
     * The bubbling version dismisses the dialog when somebody finishes a text
     * selection inside it, losing whatever they typed.
     */
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    await userEvent.click(screen.getByText('This cannot be undone.'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('returns focus to whatever opened it', async () => {
    function OpenAndClose() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)} type="button">
            Open
          </button>
          <Dialog onClose={() => setOpen(false)} open={open} title="Revoke access">
            <p>body</p>
          </Dialog>
        </>
      );
    }

    render(<OpenAndClose />);
    const trigger = screen.getByRole('button', { name: 'Open' });

    await userEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeVisible();

    await userEvent.keyboard('{Escape}');
    // Without this the user is dropped at the top of the document, having lost
    // their place entirely.
    expect(trigger).toHaveFocus();
  });
});
