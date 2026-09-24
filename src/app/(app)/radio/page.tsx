import type { Metadata } from "next";
import { fetchHomeSections } from "@/lib/providers/server";
import { TrackList } from "@/components/tracks/track-list";
import { SectionHeader } from "@/components/home/section-header";
import { EmptyState } from "@/components/ui/empty-state";
import { RadioIcon, MusicNoteIcon } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Radio" };

const moods = [
  { name: "Ambient", blurb: "Atmospheric textures to work and drift." },
  { name: "Electronic", blurb: "Synthetic beats, bright and forward." },
  { name: "Rock & Indie", blurb: "Guitar-driven energy and hooks." },
] as const;

export default async function RadioPage() {
  const sections = await fetchHomeSections();

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-2">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
          <RadioIcon size={26} /> Radio
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
          A listening surface for uninterrupted discovery. Live audio streaming arrives in a
          later phase — what you see below is a static preview of the catalog, not a live stream.
        </p>
      </div>

      <section aria-label="Mood stations">
        <SectionHeader title="Mood stations" aside="coming in a later phase" />
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {moods.map((mood) => (
            <li
              key={mood.name}
              className="flex flex-col gap-1 rounded-card border border-border-subtle bg-surface-1 p-4"
            >
              <span className="text-sm font-semibold text-text-primary">{mood.name}</span>
              <span className="text-xs leading-relaxed text-text-muted">{mood.blurb}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <SectionHeader title="Explore the catalog" aside="preview only" />
        {sections.featured.length > 0 ? (
          <TrackList tracks={sections.featured} />
        ) : (
          <EmptyState
            icon={<MusicNoteIcon size={28} />}
            title="Nothing to preview yet"
            description="Featured tracks from the catalog provider will appear here."
          />
        )}
      </section>
    </div>
  );
}