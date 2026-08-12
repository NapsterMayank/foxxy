import { fireEvent,  screen } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { describe, expect, it, vi } from 'vitest';
import ErrorPage from '@/app/error';

describe('ErrorPage', () => {
  it('offers a retry without exposing the error message', () => {
    const retry = vi.fn();
    render(<ErrorPage error={new Error('private detail')} retry={retry} />);

    expect(screen.queryByText('private detail')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
