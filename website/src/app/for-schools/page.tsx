import { AudiencePage, audienceMetadata } from '@/components/audience-page';

export const metadata = audienceMetadata('schools');

export default function ForSchoolsPage() { return <AudiencePage audience="schools" />; }
