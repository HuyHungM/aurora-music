// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PlayerHost } from "@/components/player/player-host";
import { usePlayerStore } from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import { EventEnum, FakeAudioSurface } from "@/lib/player/__tests__/fake-audio";
import { setLogLevel, setLogSink } from "@/lib/diagnostics/logger";
import type { LogRecord } from "@/lib/diagnostics/logger";

const mocks = vi.hoisted(() => ({
  getDefaultEngine: vi.fn(),
  resolveAudioSourceAction: vi.fn(),
}));

vi.mock("@/lib/player/engine-factory", () => ({
  getDefaultEngine: mocks.getDefaultEngine,
}));

vi.mock("@/app/actions/playback-resolve", () => ({
  resolveAudioSourceAction: mocks.resolveAudioSourceAction,
}));

vi.mock("@/app/actions/playback", () => ({
  recordPlayedAction: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/app/actions/playback-state", () => ({
  getPlaybackStateAction: vi.fn().mockResolvedValue({ ok: true, state: null }),
  savePlaybackStateAction: vi.fn().mockResolvedValue({ ok: true }),
  clearPlaybackStateAction: vi.fn().mockResolvedValue({ ok: true }),
  getSessionUserIdAction: vi.fn().mockResolvedValue({ ok: true, userId: null }),
  resolvePlaybackTrackAction: vi.fn().mockResolvedValue({ ok: true, track: null }),
}));

function resetStore() {
  usePlayerStore.setState({
    currentTrack: null,
    isPlaying: false,
    isLoading: false,
    error: null,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    queue: [],
    playOrder: [],
    position: -1,
    shuffle: false,
    repeat: "off",
    isQueueOpen: false,
    isFullPlayerOpen: false,
    qualifiedTrackKey: null,
  });
}

function mountWithEngine() {
  const surface = new FakeAudioSurface();
  const engine = new PlayerEngine(surface);
  mocks.getDefaultEngine.mockReturnValue(engine);
  return { surface, engine };
}

function setRangeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  fireEvent.input(input);
}

const controls = () =>
  within(screen.getByRole("group", { name: "Playback controls" }));
const bar = () => within(screen.getByRole("region", { name: "Player bar" }));

function youtubeTrack(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    provider: "youtube" as const,
    providerTrackId: id,
    title: `Track ${id}`,
    artistId: "UC1",
    artistName: "Artist",
    ...overrides,
  };
}

describe("PlayerHost + player bar", () => {
  beforeEach(() => {
    resetStore();
    mountWithEngine();
    mocks.resolveAudioSourceAction.mockResolvedValue({
      ok: true,
      source: { url: `https://cdn.example/resolved.m4a`, mimeType: "audio/mp4" },
    });
  });

  afterEach(() => {
    cleanup();
    usePlayerStore.getState().bindEngine(null);
  });

  it("renders an empty bar until a track is loaded", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    expect(await screen.findByText("Nothing playing")).toBeTruthy();
    expect(controls().getByRole("button", { name: "Play" })).toHaveProperty("disabled", true);
  });

  it("shows the current track and toggles playback from the bar", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().playTrack(youtubeTrack("aaaaaaaaaaa", { artistName: "Bar Artist" }));
    expect(await bar().findByText("Track aaaaaaaaaaa")).toBeTruthy();
    expect(bar().getByText("Bar Artist")).toBeTruthy();
    await controls().findByRole("button", { name: "Pause" });

    fireEvent.click(controls().getByRole("button", { name: "Pause" }));
    expect(await controls().findByRole("button", { name: "Play" })).toBeTruthy();

    fireEvent.click(controls().getByRole("button", { name: "Play" }));
    expect(await controls().findByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("displays the stream error message in an accessible status region", async () => {
    mocks.resolveAudioSourceAction.mockResolvedValue({
      ok: false,
      error: {
        name: "PlaybackResolutionError",
        code: "PLAYBACK_RESOLUTION_ERROR",
        message: "no playable stream for this video",
        retryable: false,
        provider: "youtube",
      },
    });
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().playTrack(youtubeTrack("aaaaaaaaaaa"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("no playable stream"),
    );
  });

  it("updates seek, volume and mute through the controls", async () => {
    const { surface } = mountWithEngine();
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().playTrack(youtubeTrack("aaaaaaaaaaa"));
    await bar().findByText("Track aaaaaaaaaaa");

    surface.duration = 200;
    surface.dispatch(EventEnum.loadedmetadata);
    await screen.findByText("3:20");

    setRangeValue(screen.getByLabelText("Seek"), "40");
    expect(await screen.findByText("0:40")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(await screen.findByRole("button", { name: "Unmute" })).toBeTruthy();

    setRangeValue(screen.getByLabelText("Volume"), "0.25");
    await waitFor(() => expect(usePlayerStore.getState().volume).toBe(0.25));
  });

  it("shows the mobile mini player once a track is loaded and toggles there", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().playTrack(
      youtubeTrack("bbbbbbbbbbb", { artistName: "Mini Artist" }),
    );
    const mini = within(await screen.findByRole("region", { name: "Mini player" }));
    expect(mini.getByText("Track bbbbbbbbbbb")).toBeTruthy();
    expect(mini.getByText("Mini Artist")).toBeTruthy();

    fireEvent.click(mini.getByRole("button", { name: "Pause" }));
    expect(await mini.findByRole("button", { name: "Play" })).toBeTruthy();

    fireEvent.click(mini.getByRole("button", { name: "Play" }));
    expect(await mini.findByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("logs host initialization and shutdown exactly once", async () => {
    const records: LogRecord[] = [];
    const restore = setLogSink((record) => {
      records.push(record);
    });
    setLogLevel("debug");
    try {
      const { unmount } = render(<PlayerHost />);
      await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
      unmount();
      expect(records.map((record) => record.event)).toEqual([
        "app_initialized",
        "app_shutdown",
      ]);
    } finally {
      restore();
      setLogLevel("error");
    }
  });
});