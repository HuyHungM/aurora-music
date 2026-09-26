import type { Locale } from "@/lib/i18n/locale";
import { DEFAULT_LOCALE } from "@/lib/i18n/locale";
import { getT } from "@/lib/i18n/translate";
import { SearchField } from "@/components/search/search-field";

/**
 * The `/search` page's own field.
 *
 * The input itself is the shared client `SearchField`; this stays a server
 * component so the copy is resolved in the request locale (no client
 * dictionary, no hydration mismatch) and so the query the page rendered
 * results for is the exact query the field starts with.
 */
export function SearchForm({
  defaultValue,
  locale = DEFAULT_LOCALE,
}: {
  defaultValue: string;
  locale?: Locale;
}) {
  const t = getT(locale);
  return (
    <SearchField
      id="search-q"
      variant="page"
      label={t("searchForm.label")}
      placeholder={t("searchForm.placeholder")}
      clearLabel={t("searchForm.clear")}
      defaultValue={defaultValue}
    />
  );
}
