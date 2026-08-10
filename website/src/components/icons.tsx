type IconName = 'book' | 'chart' | 'exam' | 'language' | 'practice' | 'spark';

const paths: Record<IconName, React.ReactNode> = {
  spark: <path d="M12 2l1.5 5.1L18 9l-4.5 1.9L12 16l-1.5-5.1L6 9l4.5-1.9L12 2Zm6 13 .8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8L18 15Z" />,
  book: <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H11v17H6.5A2.5 2.5 0 0 0 4 21.5v-17Zm16 0A2.5 2.5 0 0 0 17.5 2H13v17h4.5a2.5 2.5 0 0 1 2.5 2.5v-17Z" />,
  practice: <path d="M7 3h10v4H7V3Zm-2 6h14v12H5V9Zm3 3h8M8 16h5" />,
  chart: <path d="M4 20V10m6 10V4m6 16v-7m5 7H2" />,
  exam: <path d="M6 3h12v18H6V3Zm3 5h6m-6 4h6m-6 4h4" />,
  language: <path d="M4 5h9m-5-2v2m3 0c-.7 4-3.2 7-7 8m2-5c1.6 2.2 3.6 3.7 6 4m2 8 3.5-9L21 20m-5.7-3h4.4" />,
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg aria-hidden="true" className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
      {paths[name]}
    </svg>
  );
}
