import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../button';
import { ButtonLink } from '../button-link';
import { ParentIllustration, StudentIllustration } from '../role-illustrations';

/**
 * THE SHARED PRIMITIVES — plan §10.4 ("every primitive renders each variant")
 * and §12 ("every interactive element is keyboard reachable, has an accessible
 * name, and is at least 44 by 44 pixels").
 *
 * These are the cheapest tests in the project and they guard the most reused
 * code: a regression in `Button` is a regression on every screen at once.
 */

describe('Button', () => {
  it('defaults to type="button", which is the bug this default exists to prevent', async () => {
    // A bare <button> inside a form defaults to `submit`. A "show hint" button
    // that submits the practice form is a data loss, not a styling problem.
    const onSubmit = vi.fn((event: React.FormEvent) => {
      event.preventDefault();
    });
    render(
      <form onSubmit={onSubmit}>
        <Button>Show hint</Button>
      </form>,
    );

    expect(screen.getByRole('button', { name: 'Show hint' })).toHaveAttribute('type', 'button');
    await userEvent.click(screen.getByRole('button', { name: 'Show hint' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits when explicitly asked to', async () => {
    const onSubmit = vi.fn((event: React.FormEvent) => {
      event.preventDefault();
    });
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit">Sign in</Button>
      </form>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('is reachable and activated by the keyboard', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Continue</Button>);

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('carries the 44px minimum touch target and the brand token, not a colour literal', () => {
    render(<Button>Continue</Button>);
    const className = screen.getByRole('button', { name: 'Continue' }).className;

    // §12: every interactive element is at least 44 by 44 pixels.
    expect(className).toContain('min-h-control');
    // A hard-coded purple renders wrong in the parent theme (§9.1).
    expect(className).toContain('bg-brand');
    expect(className).not.toMatch(/purple|orange/);
  });

  it('does not fire when disabled, and says so to assistive technology', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Submit
      </Button>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
  });

  it('appends a caller class without dropping its own', () => {
    render(<Button className="mt-6">Continue</Button>);
    const className = screen.getByRole('button', { name: 'Continue' }).className;
    expect(className).toContain('mt-6');
    expect(className).toContain('min-h-control');
  });
});

describe('ButtonLink', () => {
  it('is a link with an accessible name independent of its visible text', () => {
    // The visible label is often an arrow or a short word; the accessible name
    // has to say where it goes.
    render(
      <ButtonLink href="/signup" label="Create a student account">
        Continue
      </ButtonLink>,
    );

    const link = screen.getByRole('link', { name: 'Create a student account' });
    expect(link).toHaveAttribute('href', '/signup');
    expect(link).toHaveTextContent('Continue');
  });

  it('meets the touch target and uses the brand token', () => {
    render(
      <ButtonLink className="w-full" href="/login" label="Sign in">
        Sign in
      </ButtonLink>,
    );
    const className = screen.getByRole('link', { name: 'Sign in' }).className;

    expect(className).toContain('min-h-control');
    expect(className).toContain('bg-brand');
    expect(className).toContain('w-full');
  });
});

describe('the role illustrations', () => {
  it.each([
    ['student', StudentIllustration],
    ['parent', ParentIllustration],
  ])('renders the %s illustration as decoration, not content', (_name, Illustration) => {
    const { container } = render(<Illustration />);
    const svg = container.querySelector('svg');

    // `role="presentation"` — the illustration repeats what the heading beside
    // it already says, and announcing it twice is noise for a screen reader.
    expect(svg).toHaveAttribute('role', 'presentation');
    // Sized by a NAMED token: a raw `h-28` does not exist under the closed
    // scale and would render at zero.
    expect(svg?.getAttribute('class')).toContain('h-illustration');
  });
});
