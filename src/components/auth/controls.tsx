import type { AuthAvailability } from "@/lib/auth/availability";
import type { Locale } from "@/lib/i18n/locale";
import { DEFAULT_LOCALE } from "@/lib/i18n/locale";
import { getT } from "@/lib/i18n/translate";
import { signInWith, signOutUser } from "@/app/actions/auth";
import { Button, ButtonLink } from "@/components/ui/button";
import { LogOutIcon } from "@/components/ui/icons";

export function SignInControl({
  availability,
  locale = DEFAULT_LOCALE,
}: {
  availability: AuthAvailability;
  locale?: Locale;
}) {
  const t = getT(locale);
  if (!availability.configured) {
    return (
      <span
        className="inline-flex h-10 cursor-not-allowed items-center rounded-full border border-border-subtle px-4 text-sm text-text-muted"
        title={t("auth.signInUnavailableTitle")}
      >
        {t("auth.signInUnavailable")}
      </span>
    );
  }

  const provider = availability.google ? "google" : "github";

  return (
    <form action={signInWith}>
      <input type="hidden" name="provider" value={provider} />
      <Button type="submit" size="md">
        {t("auth.signIn")}
      </Button>
    </form>
  );
}

export function SignOutControl({
  name,
  locale = DEFAULT_LOCALE,
}: {
  name?: string;
  locale?: Locale;
}) {
  const t = getT(locale);
  return (
    <form action={signOutUser}>
      <button
        type="submit"
        aria-label={name ? t("auth.signOutLabel", { name }) : t("auth.signOut")}
        className="aurora-touch inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
      >
        <LogOutIcon size={18} />
      </button>
    </form>
  );
}

export function LibrarySignedOutCta({ locale = DEFAULT_LOCALE }: { locale?: Locale }) {
  const t = getT(locale);
  return (
    <div className="flex flex-col items-center gap-4 rounded-card border border-border-subtle bg-surface-1 px-6 py-12 text-center">
      <h2 className="text-lg font-semibold text-text-primary">{t("library.signedOutTitle")}</h2>
      <p className="max-w-md text-sm leading-relaxed text-text-muted">
        {t("library.signedOutDescription")}
      </p>
      <ButtonLink href="/" variant="secondary">
        {t("common.backHome")}
      </ButtonLink>
    </div>
  );
}
