import type { Metadata } from "next";
import { getRequestLocale } from "@/lib/i18n/server";
import { getT } from "@/lib/i18n/translate";
import { OfflineLibrary } from "@/components/offline/offline-library";

export const metadata: Metadata = { title: "Local files" };

/**
 * /offline — audio the user already has on their own device.
 *
 * A server component that renders ONE client island and nothing else. There is
 * deliberately no server data fetching here: a local folder is a property of
 * the browser profile that opened it, so anything the server knew about it
 * would be wrong on the next visit. The page also stays reachable while signed
 * out, because the music is not in the account.
 */
export default async function OfflinePage() {
  const locale = await getRequestLocale();
  const t = getT(locale);
  return (
    <div className="flex flex-col gap-6 sm:gap-10">
      <span className="sr-only">{t("offline.title")}</span>
      <OfflineLibrary />
    </div>
  );
}