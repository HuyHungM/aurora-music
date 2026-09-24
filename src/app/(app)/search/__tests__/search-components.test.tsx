// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RecordSearch } from "../record-search";
import { SearchHistorySection } from "../search-history";
import type { SearchHistory } from "@/lib/domain";

const mocks = vi.hoisted(() => ({
  recordSearchAction: vi.fn().mockResolvedValue(undefined),
  clearSearchHistoryAction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/app/actions/search", () => ({
  recordSearchAction: mocks.recordSearchAction,
  clearSearchHistoryAction: mocks.clearSearchHistoryAction,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RecordSearch", () => {
  it("calls recordSearchAction with the query on mount", () => {
    render(<RecordSearch query="test query" />);
    expect(mocks.recordSearchAction).toHaveBeenCalledWith("test query");
  });

  it("does not call recordSearchAction when query is empty", () => {
    render(<RecordSearch query="" />);
    expect(mocks.recordSearchAction).not.toHaveBeenCalled();
  });

  it("re-calls recordSearchAction when query changes", () => {
    const { rerender } = render(<RecordSearch query="first" />);
    expect(mocks.recordSearchAction).toHaveBeenCalledWith("first");
    rerender(<RecordSearch query="second" />);
    expect(mocks.recordSearchAction).toHaveBeenCalledWith("second");
  });
});

describe("SearchHistorySection", () => {
  const history: SearchHistory[] = [
    { id: "h1", userId: "u1", query: "aurora", searchedAt: "2024-01-01" },
    { id: "h2", userId: "u1", query: "beatles", searchedAt: "2024-01-02" },
  ];

  it("renders history items", () => {
    render(<SearchHistorySection history={history} />);
    expect(screen.getByText("aurora")).toBeTruthy();
    expect(screen.getByText("beatles")).toBeTruthy();
  });

  it("renders the section heading", () => {
    render(<SearchHistorySection history={history} />);
    expect(screen.getByText("Recent searches")).toBeTruthy();
  });

  it("renders nothing when history is empty", () => {
    const { container } = render(<SearchHistorySection history={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("has a clear button", () => {
    render(<SearchHistorySection history={history} />);
    expect(screen.getByText("Clear")).toBeTruthy();
  });

  it("clear button has accessible label", () => {
    render(<SearchHistorySection history={history} />);
    expect(screen.getByRole("button", { name: "Clear search history" })).toBeTruthy();
  });
});
