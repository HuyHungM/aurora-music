import type { AuthAvailability } from "@/lib/auth/availability";
import { signInWith, signOutUser } from "@/app/actions/auth";
import { Button, ButtonLink } from "@/components/ui/button";
import { LogOutIcon } from "@/components/ui/icons";

export function SignInControl({ availability }: { availability: AuthAvailability }) {
  if (!availability.configured) {
    return (
      <span
        className="inline-flex h-10 cursor-not-allowed items-center rounded-full border border-border-subtle px-4 text-sm text-text-muted"
        title="No sign-in providers are configured for this instance"
      >
        Sign-in unavailable
      </span>
    );
  }

  const provider = availability.google ? "google" : "github";

  return (
    <form action={signInWith}>
      <input type="hidden" name="provider" value={provider} />
      <Button type="submit" size="md">
        Sign in
      </Button>
    </form>
  );
}

export function SignOutControl({ name }: { name?: string }) {
  return (
    <form action={signOutUser}>
      <button
        type="submit"
        aria-label={name ? `Sign out ${name}` : "Sign out"}
        className="inline-flex h-10 w-10 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
      >
        <LogOutIcon size={18} />
      </button>
    </form>
  );
}

export function LibrarySignedOutCta() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-card border border-border-subtle bg-surface-1 px-6 py-12 text-center">
      <h2 className="text-lg font-semibold text-text-primary">Your library is waiting</h2>
      <p className="max-w-md text-sm leading-relaxed text-text-muted">
        Signed-in users can save likes, playlists, and recently played music to Aurora.
        Sign in to get started — or ask the instance admin to configure a sign-in provider.
      </p>
      <ButtonLink href="/" variant="secondary">
        Back to home
      </ButtonLink>
    </div>
  );
}