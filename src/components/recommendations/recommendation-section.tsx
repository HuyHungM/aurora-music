import type { Locale } from "@/lib/i18n/locale";
import { getT } from "@/lib/i18n/translate";
import { buildRecommendationSection } from "@/lib/recommendations/server";
import type {
  RecommendationCategory,
  RecommendationSeedTrack,
} from "@/lib/recommendations/service";
import { TrackList } from "@/components/tracks/track-list";
import { SectionHeader } from "@/components/home/section-header";
import { SparkleIcon } from "@/components/ui/icons";

/**
 * A real, deterministic recommendation section (Phase 47).
 *
 * §28: recommendations appear only where they have a distinct purpose, and a
 * section with nothing to show renders NOTHING. There is no skeleton, no
 * placeholder row, and no generic filler — an empty block is worse than an
 * absent one, because it implies the product has nothing for you rather than
 * "it could not be loaded right now".
 *
 * The heading is derived from which category actually produced the tracks,
 * so the label can never claim a personalization the pipeline did not
 * perform. An anonymous listener always sees the non-personalized
 * "Continue discovering" label.
 */

const CATEGORY_HEADING: Record<RecommendationCategory, string> = {
  "similar-to-current": "recommendations.similarToCurrent",
  "because-you-listened": "recommendations.recommendedForYou",
  "from-artists-you-follow": "recommendations.fromArtistsYouFollow",
  "based-on-likes": "recommendations.basedOnYourLikes",
  "continue-discovering": "recommendations.continueDiscovering",
};

/** Picks the single most specific label the produced categories justify. */
function headingKey(categories: readonly RecommendationCategory[]): string {
  if (categories.length === 1) {
    return CATEGORY_HEADING[categories[0] as RecommendationCategory];
  }
  // Zero categories cannot happen when tracks exist, and more than one means
  // the set is genuinely a mix — so the umbrella label is the honest one.
  return "recommendations.recommendedForYou";
}

export async function RecommendationSection({
  locale,
  seed = null,
  excludeKeys,
  limit,
  titleKey,
}: {
  locale: Locale;
  /** Anchor track; omit for a section driven by history signals alone. */
  seed?: RecommendationSeedTrack | null;
  /** Canonical keys already shown on this page, so nothing repeats. */
  excludeKeys?: readonly string[];
  limit?: number;
  /** Surface-specific label, when the page knows better than the category. */
  titleKey?: string;
}) {
  const t = getT(locale);
  const section = await buildRecommendationSection({ seed, excludeKeys, limit });
  if (section.tracks.length === 0) {
    return null;
  }
  const title = t(titleKey ?? headingKey(section.categories));
  return (
    <section aria-label={title}>
      <SectionHeader title={title} icon={<SparkleIcon size={16} />} />
      <TrackList tracks={section.tracks} showMenu={true} />
    </section>
  );
}
