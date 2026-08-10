import { AudiencePage, audienceMetadata } from '@/components/audience-page';

export const metadata = audienceMetadata('parents');

export default function ForParentsPage() { return <AudiencePage audience="parents" />; }
