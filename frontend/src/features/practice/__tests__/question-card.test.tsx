import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnswerResult, PracticeQuestion } from '@/lib/api/generated/contracts/practice.contract';
import { QuestionCard } from '../components/question-card';

afterEach(cleanup);

const question: PracticeQuestion = {
  id: '11111111-1111-4111-8111-111111111111',
  questionText: 'Which part of a plant makes food?',
  options: ['Root', 'Leaf', 'Stem', 'Flower'],
  difficulty: 'medium',
  bloomLevel: 'understand',
  hintLevelsAvailable: [],
};

const result: AnswerResult = {
  questionId: question.id,
  isCorrect: false,
  correctPresentationIndex: 1,
  explanation: 'Leaves hold the chlorophyll that captures sunlight.',
  decision: 'remediate_general',
  misconceptionCode: null,
  answeredCount: 1,
  questionCount: 6,
};

function setup(overrides: Partial<React.ComponentProps<typeof QuestionCard>> = {}) {
  const onSelect = vi.fn();
  const onAnswer = vi.fn();

  render(
    <QuestionCard
      isAnswering={false}
      onAnswer={onAnswer}
      onSelect={onSelect}
      question={question}
      questionCount={6}
      questionNumber={2}
      result={null}
      selectedIndex={null}
      {...overrides}
    />,
  );

  return { onAnswer, onSelect };
}

describe('one practice question', () => {
  it('says where the student is in the set', () => {
    setup();

    expect(screen.getByText('Question 2 of 6')).toBeInTheDocument();
  });

  /*
   * §10.4: "one option selectable at a time". A RADIO GROUP, so it is the
   * platform enforcing it — one tab stop, arrow keys between options, and no
   * `useState` that could be talked into holding two.
   */
  it('offers the options as one radio group, so only one can be chosen', () => {
    setup();

    const options = screen.getAllByRole('radio');
    expect(options).toHaveLength(4);
    for (const option of options) {
      expect(option).toHaveAttribute('name', `question-${question.id}`);
    }
  });

  it('reports the PRESENTATION index of what was pressed', () => {
    const { onSelect } = setup();

    fireEvent.click(screen.getByRole('radio', { name: 'Stem' }));

    // The options arrive shuffled and position n IS presentation index n. The
    // service translates through the session's shuffle map; nothing here
    // reorders, so index 2 means the third option this student was shown.
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it('cannot be answered before an option is chosen', () => {
    const { onAnswer } = setup();

    expect(screen.getByRole('button', { name: 'Check my answer' })).toBeDisabled();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('answers once an option is chosen', () => {
    const { onAnswer } = setup({ selectedIndex: 1 });

    fireEvent.click(screen.getByRole('button', { name: 'Check my answer' }));

    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('refuses a second press while the first is in flight', () => {
    setup({ selectedIndex: 1, isAnswering: true });

    expect(screen.getByRole('button', { name: 'Check my answer' })).toBeDisabled();
  });

  /*
   * D-281: an answer cannot be changed, and a 409 refuses a second one. The
   * card must not offer what the server will reject — a locked group is the
   * honest form of a rule the student cannot see.
   */
  it('locks every option once the answer is disclosed', () => {
    setup({ result, selectedIndex: 0 });

    for (const option of screen.getAllByRole('radio')) {
      expect(option).toBeDisabled();
    }
    expect(screen.queryByRole('button', { name: 'Check my answer' })).not.toBeInTheDocument();
  });

  /*
   * §9.1: no harsh red on an incorrect answer. The chosen-and-wrong row is
   * `warning`; the correct row is `success` whether or not it was chosen,
   * because after disclosure the useful information is where the answer is.
   */
  it('marks the wrong choice without a failure colour', () => {
    setup({ result, selectedIndex: 0 });

    const chosen = screen.getByRole('radio', { name: 'Root' }).closest('label');
    const correct = screen.getByRole('radio', { name: 'Leaf' }).closest('label');

    expect(chosen?.className).toContain('border-warning');
    expect(chosen?.className).not.toContain('border-danger');
    expect(correct?.className).toContain('border-success');
  });

  it('renders the question in a Hindi interface too', () => {
    render(
      <QuestionCard
        isAnswering={false}
        onAnswer={vi.fn()}
        onSelect={vi.fn()}
        question={question}
        questionCount={6}
        questionNumber={1}
        result={null}
        selectedIndex={null}
      />,
      { language: 'hi' },
    );

    expect(screen.getByText('सवाल 6 में से 1')).toBeInTheDocument();
  });
});
