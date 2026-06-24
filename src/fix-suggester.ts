export interface FixSuggestion {
  pattern_matched: string;
  explanation: string;
  bad_code: string;
  fixed_code: string;
  reason: string;
}

export function suggestFix(errorMessage: string, failingAction: string, selectorUsed: string): FixSuggestion {
  if (errorMessage.includes("detached") && (failingAction.includes("click") || failingAction.includes("fill"))) {
    return {
      pattern_matched: "detached-element",
      explanation: "Element detached from DOM mid-action — React likely re-rendered between locating and acting",
      bad_code: "await page.click('selector');",
      fixed_code: "const el = page.locator('selector');\nawait expect(el).toBeVisible();\nawait el.click();",
      reason: "page.click() is a one-shot locator+click with no re-render safety. Use locator() + expect().toBeVisible() to wait for stability before acting."
    };
  }

  if (errorMessage.includes("strict mode") || errorMessage.includes("resolved to")) {
    return {
      pattern_matched: "multiple-elements",
      explanation: "Locator matched multiple elements — Playwright strict mode requires exactly one",
      bad_code: "page.locator('.classname')",
      fixed_code: "page.locator('.classname').first()\n// preferred:\npage.getByRole('button', { name: 'Submit' })",
      reason: "CSS class selectors often match multiple elements. Prefer getByRole, getByTestId, or getByLabel."
    };
  }

  if (errorMessage.includes("Timeout") || errorMessage.includes("waiting for")) {
    return {
      pattern_matched: "timeout",
      explanation: "Element never appeared within the timeout window",
      bad_code: "await page.locator('selector').click();",
      fixed_code: "await expect(page.locator('selector')).toBeVisible({ timeout: 15000 });\nawait page.locator('selector').click();",
      reason: "Always assert visibility before interacting. Also check network_failures from analyze_trace — a failed API call upstream may be preventing the element from rendering."
    };
  }

  if (errorMessage.includes("net::ERR")) {
    return {
      pattern_matched: "network-failure",
      explanation: "Network request failed completely — service down or test environment connectivity issue",
      bad_code: "// No mock configured — test depends on live API",
      fixed_code: "await page.route('**/api/target-endpoint', route =>\n  route.fulfill({ status: 200, body: JSON.stringify(mockPayload) })\n);",
      reason: "Use page.route() to mock unreliable endpoints. This prevents flaky tests caused by environment issues."
    };
  }

  return {
    pattern_matched: "unknown",
    explanation: "No known pattern matched. Manual investigation needed.",
    bad_code: "",
    fixed_code: "",
    reason: "Open the full trace viewer with: npx playwright show-trace <path-to-trace.zip>"
  };
}
