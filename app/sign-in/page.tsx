import { getGoogleCredentials } from '@/lib/auth';
import { SignInForm } from './sign-in-form';
export const dynamic = 'force-dynamic';
export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <SignInForm
      googleEnabled={Boolean(getGoogleCredentials())}
      initialError={
        error ? 'Google sign-in could not finish. Try again or use email.' : ''
      }
    />
  );
}
