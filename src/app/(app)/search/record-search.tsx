"use client";

import { useEffect } from "react";
import { recordSearchAction } from "@/app/actions/search";

export function RecordSearch({ query }: { query: string }) {
  useEffect(() => {
    if (query) {
      recordSearchAction(query);
    }
  }, [query]);
  return null;
}
