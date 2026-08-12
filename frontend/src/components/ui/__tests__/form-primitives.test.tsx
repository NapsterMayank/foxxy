import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Badge } from '../badge';
import { Card } from '../card';
import { FieldProvider } from '../field-context';
import { Input, Select, Textarea } from '../input';
import { Skeleton } from '../skeleton';

/**
 * The remaining tier-1 primitives — plan §4, and §10.4's "every primitive
 * renders each variant".
 *
 * The assertions are on BEHAVIOUR and on the two class names that are
 * load-bearing rather than decorative: `text-base` (16px, or mobile Safari
 * zooms the page on focus and never undoes it) and `min-h-control` (44px).
 */

describe('Card', () => {
  it('renders a div by default and its children', () => {
    render(<Card>content</Card>);
    expect(screen.getByText('content').tagName).toBe('DIV');
  });

  it.each(['article', 'section', 'aside'] as const)('can be a %s', (element) => {
    // The right element depends on the CONTENT, not the look. Hard-coding a div
    // produces a document with no landmarks — invisible on screen, total on a
    // screen reader.
    const { container } = render(
      <Card aria-label="labelled" as={element}>
        content
      </Card>,
    );
    expect(container.querySelector(element)).not.toBeNull();
  });

  it('drops its padding when the child owns the edges', () => {
    const { container } = render(<Card padded={false}>content</Card>);
    expect(container.firstElementChild?.className).not.toContain('p-4');
  });

  it.each([
    ['raised', 'shadow-raised'],
    ['flat', 'shadow-none'],
  ] as const)('renders the %s elevation', (elevation, expected) => {
    const { container } = render(<Card elevation={elevation}>content</Card>);
    expect(container.firstElementChild?.className).toContain(expected);
  });
});

describe('Badge', () => {
  it.each(['neutral', 'brand', 'success', 'warning', 'info', 'danger'] as const)(
    'renders the %s tone',
    (tone) => {
      render(<Badge tone={tone}>label</Badge>);
      expect(screen.getByText('label')).toHaveAttribute('data-tone', tone);
    },
  );

  it('never names a brand colour directly', () => {
    // A hard-coded purple renders wrong in the parent application.
    render(<Badge tone="brand">label</Badge>);
    expect(screen.getByText('label').className).not.toMatch(/purple|orange/);
  });

  it('replaces the visible text for assistive technology when asked', () => {
    // "4/5" read aloud on its own is meaningless.
    render(
      <Badge srLabel="four of five days practised" tone="success">
        4/5
      </Badge>,
    );

    expect(screen.getByText('4/5')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('four of five days practised')).toHaveClass('sr-only');
  });
});

describe('Skeleton', () => {
  it.each(['text', 'block', 'circle'] as const)('renders the %s shape', (shape) => {
    const { container } = render(<Skeleton shape={shape} />);
    expect(container.firstElementChild).toHaveAttribute('data-shape', shape);
  });

  it('is hidden from assistive technology, always', () => {
    /*
     * A skeleton is a picture of absent content. Announced, it is a stream of
     * nothing. The announcement belongs to one busy region — `LoadingState` —
     * not to each grey box.
     */
    const { container } = render(<Skeleton />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('the text entry primitives', () => {
  it.each([
    ['input', <Input key="i" aria-label="Name" />],
    ['textarea', <Textarea key="t" aria-label="Name" />],
    [
      'select',
      <Select key="s" aria-label="Name">
        <option>One</option>
      </Select>,
    ],
  ])('%s is 16px and 44px tall', (_name, element) => {
    render(element);
    const control = screen.getByLabelText('Name');

    // Below 16px, mobile Safari zooms on focus and leaves the user on a
    // horizontally scrolled layout they did not ask for.
    expect(control.className).toContain('text-base');
    expect(control.className).toContain('min-h-control');
  });

  it('accepts typing and reports its value', async () => {
    render(<Input aria-label="Name" />);
    await userEvent.type(screen.getByLabelText('Name'), 'Aarav');
    expect(screen.getByLabelText('Name')).toHaveValue('Aarav');
  });

  it('renders unadorned outside a FormField rather than throwing', () => {
    // A caller doing their own labelling is not fought.
    render(<Input aria-label="Name" />);
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid');
  });

  it('takes its id, description and invalid state from the surrounding field', () => {
    render(
      <FieldProvider value={{ id: 'field-1', describedBy: 'field-1-error', invalid: true, required: true }}>
        <Input aria-label="Name" />
      </FieldProvider>,
    );

    const control = screen.getByLabelText('Name');
    expect(control).toHaveAttribute('id', 'field-1');
    expect(control).toHaveAttribute('aria-describedby', 'field-1-error');
    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(control).toBeRequired();
    // The visible state and the announced state cannot disagree, because both
    // come from the same source.
    expect(control.className).toContain('border-danger');
  });
});
