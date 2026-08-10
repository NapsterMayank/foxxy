import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RoleCard } from '@/components/ui/role-card';

describe('RoleCard', () => {
  it('exposes both role destinations with their expected themes', () => {
    const { container } = render(
      <>
        <RoleCard
          action="Continue as student"
          description="Student description."
          href="/login?role=student"
          illustration={<span>Student art</span>}
          label="I am a student"
          theme="student"
        />
        <RoleCard
          action="Continue as parent"
          description="Parent description."
          href="/login?role=parent"
          illustration={<span>Parent art</span>}
          label="I am a parent"
          theme="parent"
        />
      </>,
    );

    expect(screen.getByRole('heading', { name: 'I am a student' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'I am a parent' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue as student' })).toHaveAttribute(
      'href',
      '/login?role=student',
    );
    expect(screen.getByRole('link', { name: 'Continue as parent' })).toHaveAttribute(
      'href',
      '/login?role=parent',
    );
    expect(container.querySelector('[data-theme="student"]')).toBeInTheDocument();
    expect(container.querySelector('[data-theme="parent"]')).toBeInTheDocument();
  });
});
