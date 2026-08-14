import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FoxyCapabilitiesResponse } from '@/lib/api/generated/contracts/foxy.contract';
import { ActionBar } from '../components/action-bar';

afterEach(cleanup);

const actions: FoxyCapabilitiesResponse['actions'] = [
  { code: 'simpler', label: { en: 'Explain more simply', hi: 'और आसान भाषा में' } },
  { code: 'hindi', label: { en: 'Explain in Hindi', hi: 'हिंदी में समझाएँ' } },
];

describe('the fixed action set', () => {
  it('renders the labels the server sent, not a local copy', () => {
    render(<ActionBar actions={actions} disabled={false} onAction={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Explain more simply' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Explain in Hindi' })).toBeInTheDocument();
  });

  it('takes the label for the reader’s language from the same response', () => {
    render(<ActionBar actions={actions} disabled={false} onAction={vi.fn()} />, {
      language: 'hi',
    });

    expect(screen.getByRole('button', { name: 'और आसान भाषा में' })).toBeInTheDocument();
  });

  it('sends the code and not the label', () => {
    const onAction = vi.fn();
    render(<ActionBar actions={actions} disabled={false} onAction={onAction} />);

    fireEvent.click(screen.getByRole('button', { name: 'Explain in Hindi' }));

    expect(onAction).toHaveBeenCalledWith('hindi');
  });

  /*
   * THE LIST IS THE SERVER'S. A build that hardcoded `FOXY_ACTIONS` would drop
   * an action shipped after it — which is exactly the failure the contract
   * serves the list to prevent, and it fails at the moment a child presses a
   * button that is not there.
   */
  it('renders an action this build has never heard of', () => {
    render(
      <ActionBar
        actions={[{ code: 'draw_it', label: { en: 'Draw it', hi: 'इसे बनाएँ' } }]}
        disabled={false}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Draw it' })).toBeInTheDocument();
  });

  it('disables every button while an answer is arriving', () => {
    render(<ActionBar actions={actions} disabled onAction={vi.fn()} />);

    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled();
    }
  });

  it('renders nothing at all rather than an empty heading', () => {
    const { container } = render(<ActionBar actions={[]} disabled={false} onAction={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });
});
