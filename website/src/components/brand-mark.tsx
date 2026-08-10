import Link from 'next/link';

export function BrandMark() {
  return (
    <Link className="brand-mark" href="/" aria-label="Alfanumrik home">
      <span className="brand-mark__fox" aria-hidden="true">
        <span>◆</span>
      </span>
      <span>Alfanumrik</span>
    </Link>
  );
}
