// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SearchDegradationNotice } from "../search-notice";

describe("SearchDegradationNotice (Phase 37)", () => {
  it("renders nothing when results are complete", () => {
    const { container } = render(<SearchDegradationNotice partial={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("announces incompleteness in human language when degraded", () => {
    render(<SearchDegradationNotice partial={true} />);
    const notice = screen.getByRole("status");
    expect(notice).toHaveProperty(
      "textContent",
      expect.stringContaining("Một số kết quả có thể chưa đầy đủ"),
    );
    // No provider names, statuses, or technical details leak into the UI.
    expect(notice.textContent).not.toMatch(/spotify|deezer|youtube|http|401|500|failed/i);
  });
});
