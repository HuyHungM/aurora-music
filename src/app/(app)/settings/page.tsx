import type { Metadata } from "next";
import { getRequestLocale } from "@/lib/i18n/server";
import { getT } from "@/lib/i18n/translate";
import { getSessionUserId } from "@/lib/dal/session";
import { AppearancePanel } from "@/components/appearance/appearance-panel";
import { EqPanel } from "@/components/audio/eq-panel";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";

/**
 * Settings (Phase 53).
 *
 * THE FIRST PAGE IN THE APPLICATION THAT IS NOT ABOUT MUSIC. That is the
 * whole point of it, and it is also why it is reachable but not prominent:
 * `navItems` is untouched, so Settings is not a top-level navigation item
 * (§5), and the two entries into it are in the places a person looks for
 * account-level things - the sidebar footer, beside the language switcher,
 * and the mobile header, beside the same switcher.
 *
 * It is a route and not a dialog for one reason: §47 puts eight individual
 * controls plus a disclosure behind an eight-control summary, and a
 * `max-w-md` overlay is the wrong container for a form that has to be
 * scrollable and keyboard-navigable on a 360px screen. A page is also
 * deep-linkable, which is what makes the whole feature testable end to end.
 *
 * The appearance itself is NOT read here. `AppearanceRoot` already holds it,
 * one level up in the shell, and this page renders from that single authority
 * - reading it again from the server would be a second copy of the truth, and
 * the two would disagree for the length of a keystroke every time a slider
 * moved. What the server does contribute is the account, so the page can say
 * honestly where a signed-in visitor's choice is stored.
 *
 * NO PLAYBACK REACH - WITH ONE EXCEPTION, ADDED IN PHASE 53's ADDENDUM AND
 * STATED HERE RATHER THAN LEFT LYING IN A DOCSTRING. This file still imports no
 * engine, no queue module and no playback module, and rendering the page is
 * still incapable of interrupting playback. But `EqPanel` reads and writes the
 * EQ store, and the store pushes parameters at an audio graph, so the audio path
 * is now genuinely reachable from a control on this page. That is the point of
 * the feature and it is the only way an equalizer can work, so the honest
 * statement is narrower than the old one rather than being quietly abandoned.
 *
 * What the narrow statement GUARANTEES is what §31 and §32 actually need: the
 * reach is ONE WAY and it is to the EQ alone. Nothing on this page can start,
 * pause, skip, reseek or replace a track, no control here reads or writes the
 * queue, and the graph is attached to the existing element rather than owning
 * playback. `eq-store.ts` has no import from any playback module, and a quality
 * gate asserts that - so a track change, a queue transition, a radio seed and a
 * resolver retry all travel paths that cannot reach EQ state and therefore
 * cannot reset it.
 */
export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  return { title: getT(locale)("settings.title") };
}

export default async function SettingsPage() {
  const locale = await getRequestLocale();
  const t = getT(locale);
  const userId = await getSessionUserId().catch(() => null);

  return (
    <div className="flex flex-col gap-6 sm:gap-10">
      <section className="flex flex-col items-start gap-3">
        <h1 className="t-page-title">{t("settings.title")}</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
          {t("settings.subtitle")}
        </p>
        {/* Where the choice is actually kept, stated plainly rather than
            implied. A signed-out visitor deserves to know their glass setting
            lives in this browser and nowhere else. */}
        <p className="t-caption" data-testid="settings-storage-note">
          {t(userId ? "settings.storageAccount" : "settings.storageDevice")}
        </p>
      </section>

      <hr className="border-t border-border-subtle" />

      <section aria-labelledby="settings-appearance" className="flex flex-col gap-4">
        <h2 id="settings-appearance" className="t-section-title text-text-primary">
          {t("settings.appearance")}
        </h2>
        <AppearancePanel />
      </section>

      <hr className="border-t border-border-subtle" />

      {/*
        Audio (§36). Between Appearance and Language, because the reading order
        of a settings page should be "how it looks, how it sounds, what language
        it is in" - visual, then audible, then textual - and because an equalizer
        most people will never open belongs below the two things most people will.
      */}
      <section aria-labelledby="settings-audio" className="flex flex-col gap-4">
        <h2 id="settings-audio" className="t-section-title text-text-primary">
          {t("eq.section")}
        </h2>
        <EqPanel />
      </section>

      <hr className="border-t border-border-subtle" />

      <section aria-labelledby="settings-language" className="flex flex-col gap-4">
        <h2 id="settings-language" className="t-section-title text-text-primary">
          {t("settings.language")}
        </h2>
        <p className="t-caption max-w-prose">
          {t("settings.languageDescription")}
        </p>
        {/* The SAME switcher the sidebar and the header use, not a settings-
            only variant. A second control for the same preference is a second
            thing that can drift, and the switcher's own docstring already
            makes the case for sharing it. */}
        <LocaleSwitcher />
      </section>
    </div>
  );
}
