"use client";

/**
 * Local-files panel for /offline — the entire interactive surface for the
 * offline source.
 *
 * WHY AN EXPLICIT STATE MACHINE. Every state here is reachable, and several
 * are ORDINARY rather than exceptional: a returning user whose browser
 * restarted sees `needs-permission`, exactly as normal as having picked a
 * folder. Collapsing them into `loading | ready | error` is what makes
 * revoked-permission UIs lie, so each state names itself and offers the one
 * action that moves it forward.
 *
 * SCANNING IS NEVER AUTOMATIC. On mount a stored handle is an OFFER, not an
 * instruction: the user's disk is read only after they click. Reading someone's
 * music library without being asked is the one thing this feature must not do,
 * so a returning user gets a button rather than a surprise.
 *
 * NOTHING LEAVES THE DEVICE. File names, sizes and durations are read through
 * the File System Access API. No upload, no server action, no telemetry. The
 * one persisted value is the folder HANDLE (`lib/offline/folder-store.ts`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Track } from "@/lib/domain";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FolderIcon, MusicNoteIcon } from "@/components/ui/icons";
import { useLocale } from "@/components/i18n/locale-provider";
import { useMusicEngine } from "@/lib/music/use-music-engine";
import { plural } from "@/lib/i18n/translate";
import { pickDirectory, supportsDirectoryPicker } from "@/lib/offline/capability";
import {
  clearStoredFolder,
  folderStatus,
  readStoredFolder,
  requestFolderPermission,
  writeStoredFolder,
} from "@/lib/offline/folder-store";
import { scanOfflineFolder } from "@/lib/offline/scan";
import { replaceFileRegistry, resetOfflineSession } from "@/lib/offline/session";
import { defaultOfflineStore, type OfflineKeyValueStore } from "@/lib/offline/storage";
import type { OfflineDirectoryHandle, OfflineTrackFile } from "@/lib/offline/types";
import { localTrack } from "@/lib/offline/tracks";
import { OfflineTrackRow } from "./offline-track-row";

type PanelState =
  | { kind: "unsupported" }
  | { kind: "empty" }
  | { kind: "needs-permission"; handle: OfflineDirectoryHandle }
  | { kind: "denied"; handle: OfflineDirectoryHandle }
  | { kind: "unavailable"; folderName: string | null }
  | { kind: "scanning"; handle: OfflineDirectoryHandle }
  | {
      kind: "ready";
      handle: OfflineDirectoryHandle;
      files: OfflineTrackFile[];
      truncated: boolean;
    };

function folderNameOf(handle: OfflineDirectoryHandle): string | null {
  return typeof handle.name === "string" && handle.name.length > 0 ? handle.name : null;
}

export function OfflineLibrary() {
  const { t, locale } = useLocale();
  const engine = useMusicEngine();
  const [state, setState] = useState<PanelState>({ kind: "unsupported" });

  // Created once, kept out of state: a store is a handle to browser storage,
  // not renderable data, and putting it in state would re-run the restore
  // effect below on every render.
  const storeRef = useRef<OfflineKeyValueStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = defaultOfflineStore();
  }

  const scan = useCallback(async (handle: OfflineDirectoryHandle) => {
    setState({ kind: "scanning", handle });
    const registry = new Map();
    try {
      const result = await scanOfflineFolder(handle, registry);
      // Registered only after a complete scan. A failed walk must not leave a
      // partial registry that would let the player resolve a file the user
      // cannot see listed.
      replaceFileRegistry(registry);
      setState({
        kind: "ready",
        handle,
        files: result.files,
        truncated: result.truncated,
      });
    } catch {
      setState({ kind: "unavailable", folderName: folderNameOf(handle) });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supportsDirectoryPicker()) {
        if (!cancelled) setState({ kind: "unsupported" });
        return;
      }
      const store = storeRef.current;
      const handle = store ? await readStoredFolder(store) : null;
      if (cancelled) return;
      if (!handle) {
        setState({ kind: "empty" });
        return;
      }
      const status = await folderStatus(handle);
      if (cancelled) return;
      if (status.state === "ready") {
        await scan(handle);
        return;
      }
      if (status.state === "denied") {
        setState({ kind: "denied", handle });
        return;
      }
      setState({ kind: "needs-permission", handle });
    })();
    return () => {
      cancelled = true;
    };
  }, [scan]);

  const chooseFolder = useCallback(async () => {
    try {
      const handle = await pickDirectory();
      // `null` is the user dismissing the native dialog. Not a failure, and it
      // must not overwrite the state they were already in.
      if (!handle) return;
      const store = storeRef.current;
      if (store) {
        await writeStoredFolder(store, handle);
      }
      await scan(handle);
    } catch {
      setState({ kind: "unavailable", folderName: null });
    }
  }, [scan]);

  const grantAccess = useCallback(async () => {
    if (state.kind !== "needs-permission" && state.kind !== "denied") return;
    const permission = await requestFolderPermission(state.handle);
    if (permission === "granted") {
      await scan(state.handle);
      return;
    }
    setState({ kind: "denied", handle: state.handle });
  }, [scan, state]);

  const forgetFolder = useCallback(async () => {
    const store = storeRef.current;
    if (store) {
      await clearStoredFolder(store);
    }
    resetOfflineSession();
    setState({ kind: "empty" });
  }, []);

  const files = state.kind === "ready" ? state.files : [];
  const trackCountLabel = useMemo(
    () =>
      plural(locale, files.length, {
        one: t("offline.trackCountOne", { count: files.length }),
        other: t("offline.trackCount", { count: files.length }),
      }),
    [locale, files.length, t],
  );

  // The engine is null until PlayerHost binds it. Play and Queue are no-ops
  // in that window rather than an error: the panel is already inside the app
  // shell, so the gap is one frame at most.
  const playTrack = useCallback(
    (track: Track) => {
      void engine?.play(track);
    },
    [engine],
  );
  const queueTrack = useCallback(
    (track: Track) => {
      engine?.queue.add(track);
    },
    [engine],
  );

  const header = (
    <section className="flex flex-col items-start gap-3">
      <p className="t-eyebrow">{t("offline.navLabel")}</p>
      <h1 className="t-page-title flex items-center gap-2 sm:text-3xl">
        <FolderIcon size={26} /> {t("offline.title")}
      </h1>
      <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
        {t("offline.subtitle")}
      </p>
      <p className="max-w-2xl text-xs leading-relaxed text-text-muted">
        {t("offline.privacyNote")}
      </p>
    </section>
  );

  if (state.kind === "unsupported") {
    return (
      <div className="flex flex-col gap-6 sm:gap-10">
        {header}
        <EmptyState
          icon={<FolderIcon size={24} />}
          title={t("offline.unsupportedTitle")}
          description={t("offline.unsupportedBody")}
        />
      </div>
    );
  }

  if (state.kind === "empty") {
    return (
      <div className="flex flex-col gap-6 sm:gap-10">
        {header}
        <EmptyState
          icon={<FolderIcon size={24} />}
          title={t("offline.chooseFolder")}
          description={t("offline.subtitle")}
          action={
            <Button onClick={chooseFolder} variant="primary" size="sm">
              {t("offline.chooseFolder")}
            </Button>
          }
        />
      </div>
    );
  }

  if (state.kind === "needs-permission" || state.kind === "denied") {
    const denied = state.kind === "denied";
    return (
      <div className="flex flex-col gap-6 sm:gap-10">
        {header}
        <EmptyState
          icon={<FolderIcon size={24} />}
          title={denied ? t("offline.deniedTitle") : t("offline.needsPermissionTitle")}
          description={denied ? t("offline.deniedBody") : t("offline.needsPermissionBody")}
          action={
            <div className="flex flex-wrap gap-2">
              <Button onClick={grantAccess} variant="primary" size="sm">
                {t("offline.grantAccess")}
              </Button>
              <Button onClick={chooseFolder} variant="ghost" size="sm">
                {t("offline.changeFolder")}
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <div className="flex flex-col gap-6 sm:gap-10">
        {header}
        <EmptyState
          icon={<FolderIcon size={24} />}
          title={t("offline.unavailableTitle")}
          description={t("offline.unavailableBody")}
          action={
            <Button onClick={chooseFolder} variant="primary" size="sm">
              {t("offline.chooseFolder")}
            </Button>
          }
        />
      </div>
    );
  }

  if (state.kind === "scanning") {
    return (
      <div className="flex flex-col gap-6 sm:gap-10">
        {header}
        <p role="status" className="text-sm text-text-muted">
          {t("offline.scanning")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 sm:gap-10">
      {header}

      <section className="flex flex-wrap items-center gap-3">
        <span className="rounded-full bg-surface-1 px-3 py-1 text-xs text-text-muted">
          {t("offline.folderLabel", { name: folderNameOf(state.handle) ?? "" })}
        </span>
        <span className="text-xs text-text-muted">{trackCountLabel}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button onClick={() => void scan(state.handle)} variant="ghost" size="sm">
            {t("offline.reScan")}
          </Button>
          <Button onClick={chooseFolder} variant="secondary" size="sm">
            {t("offline.changeFolder")}
          </Button>
          <Button onClick={forgetFolder} variant="ghost" size="sm">
            {t("offline.forgetFolder")}
          </Button>
        </div>
      </section>

      {state.truncated ? (
        <p role="status" className="text-xs text-text-muted">
          {t("offline.truncatedWarning")}
        </p>
      ) : null}

      {files.length === 0 ? (
        <EmptyState
          icon={<MusicNoteIcon size={24} />}
          title={t("offline.emptyFolder")}
          description={t("offline.privacyNote")}
          action={
            <Button onClick={chooseFolder} variant="secondary" size="sm">
              {t("offline.changeFolder")}
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-1">
          {files.map((file) => (
            <OfflineTrackRow
              key={file.id}
              file={file}
              playLabel={t("offline.playTrack", { title: file.name })}
              queueLabel={t("offline.queueTrack", { title: file.name })}
              fileLabel={t("offline.fileNameLabel", { name: file.name })}
              onPlay={playTrack}
              onQueue={queueTrack}
              buildTrack={localTrack}
            />
          ))}
        </ul>
      )}
    </div>
  );
}