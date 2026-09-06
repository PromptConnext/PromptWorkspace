import { describe, expect, it } from "vitest";
import {
  buildVersions,
  isPreviewReadyMessage,
  relativeTime,
  resolvePreview,
  safeWebUrl,
  shortSha,
} from "./previewState";
import type { DeploymentOut, DeploymentStatus } from "@/lib/types";

function status(overrides: Partial<DeploymentStatus> = {}): DeploymentStatus {
  return {
    template_id: "static-r2",
    template_name: "Static site → PromptZone hosting",
    provider: "platform-r2",
    embeddable: true,
    state: "live",
    url: "https://preview.test/previews/p1/index.html",
    health_path: "/index.html",
    pending: 0,
    last_deploy: null,
    recent: [],
    last_error: null,
    ...overrides,
  };
}

describe("resolvePreview", () => {
  it("is empty when no template was ever chosen", () => {
    const view = resolvePreview(status({ state: "not_configured" }), "pending");
    expect(view.mode).toBe("empty");
    expect(view.polling).toBe(false);
  });

  it("is empty before any status has loaded", () => {
    expect(resolvePreview(null, "pending").mode).toBe("empty");
  });

  it("waits, and keeps polling, between repo creation and the first deploy", () => {
    const view = resolvePreview(status({ state: "awaiting_first_deploy", url: null }), "pending");
    expect(view.mode).toBe("waiting");
    expect(view.polling).toBe(true);
  });

  it("polls while a deploy is in flight", () => {
    const view = resolvePreview(status({ state: "building", pending: 1 }), "pending");
    expect(view.mode).toBe("building");
    expect(view.polling).toBe(true);
  });

  it("embeds a live, embeddable deploy", () => {
    expect(resolvePreview(status(), "confirmed").mode).toBe("embed");
  });

  it("falls back to a link when the server measured a framing refusal", () => {
    const view = resolvePreview(
      status({
        embeddable: false,
        last_deploy: {
          id: "d1",
          state: "live",
          url: "https://preview.test/",
          commit_sha: "abc1234def",
          ref: "main",
          run_url: null,
          frame_policy: "deny",
          created_at: "2026-08-19T00:00:00Z",
          updated_at: "2026-08-19T00:00:00Z",
        },
      }),
      "pending",
    );
    expect(view.mode).toBe("link");
    expect(view.fallbackReason).toMatch(/not to be displayed/i);
  });

  it("falls back to a link when the handshake times out, without claiming a refusal", () => {
    const view = resolvePreview(status(), "timed-out");
    expect(view.mode).toBe("link");
    // The distinction that matters: we did not observe a refusal, so we must
    // not report one.
    expect(view.fallbackReason).toMatch(/could not confirm/i);
    expect(view.fallbackReason).not.toMatch(/refus/i);
  });

  it("keeps the last known good url when the newest deploy failed", () => {
    const view = resolvePreview(
      status({ state: "failed", url: "https://preview.test/previews/p1/index.html" }),
      "pending",
    );
    expect(view.mode).toBe("failed");
    expect(view.url).toBe("https://preview.test/previews/p1/index.html");
  });

  it("waits rather than embedding when a live state somehow carries no url", () => {
    expect(resolvePreview(status({ url: null }), "confirmed").mode).toBe("waiting");
  });
});

describe("isPreviewReadyMessage", () => {
  const url = "https://preview.test/previews/p1/index.html";

  it("accepts our tag from the deployed origin", () => {
    expect(isPreviewReadyMessage({ pz: "preview-ready" }, "https://preview.test", url)).toBe(true);
  });

  it("rejects the same tag from any other origin", () => {
    expect(isPreviewReadyMessage({ pz: "preview-ready" }, "https://evil.test", url)).toBe(false);
  });

  it("rejects unrelated messages from the right origin", () => {
    expect(isPreviewReadyMessage({ type: "webpack-ok" }, "https://preview.test", url)).toBe(false);
    expect(isPreviewReadyMessage("preview-ready", "https://preview.test", url)).toBe(false);
    expect(isPreviewReadyMessage(null, "https://preview.test", url)).toBe(false);
  });

  it("rejects rather than throwing on an unparseable url", () => {
    expect(isPreviewReadyMessage({ pz: "preview-ready" }, "https://preview.test", "not a url")).toBe(
      false,
    );
  });
});

describe("shortSha", () => {
  it("shortens a sha and passes through nothing", () => {
    expect(shortSha("abc1234def5678")).toBe("abc1234");
    expect(shortSha(null)).toBeNull();
    expect(shortSha(undefined)).toBeNull();
  });
});


describe("safeWebUrl", () => {
  // This value's provenance is a webhook payload written by whoever can push
  // to the project repo, and it ends up in an href and an iframe src. React
  // does not sanitise either.
  it.each([
    "javascript:alert(document.domain)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "/relative/path",
    "not a url",
    "",
  ])("refuses %s", (url) => {
    expect(safeWebUrl(url)).toBeNull();
  });

  it("refuses null and undefined", () => {
    expect(safeWebUrl(null)).toBeNull();
    expect(safeWebUrl(undefined)).toBeNull();
  });

  it("accepts ordinary http and https urls", () => {
    expect(safeWebUrl("https://preview.test/p/")).toBe("https://preview.test/p/");
    expect(safeWebUrl("http://localhost:3000/")).toBe("http://localhost:3000/");
  });
});

describe("resolvePreview url safety", () => {
  it("never hands a javascript: url to any mode", () => {
    for (const state of ["live", "failed", "building", "awaiting_first_deploy"] as const) {
      const view = resolvePreview(
        status({ state, url: "javascript:alert(1)" }),
        "confirmed",
      );
      expect(view.url).toBeNull();
    }
  });

  it("does not claim to embed a url it had to reject", () => {
    const view = resolvePreview(status({ url: "javascript:alert(1)" }), "confirmed");
    expect(view.mode).toBe("waiting");
  });
});

// ADR 0023: the version list a business user reads.
function deployRow(over: Partial<DeploymentOut> = {}): DeploymentOut {
  return {
    id: "d1",
    state: "live",
    url: "https://preview.test/p/index.html",
    commit_sha: "abc1234def",
    ref: "main",
    run_url: "https://github.com/acme/rocket/actions/runs/1",
    frame_policy: "allow",
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
    ...over,
  };
}

function statusWithHistory(recent: DeploymentOut[]): DeploymentStatus {
  return status({ url: recent[0]?.url ?? null, last_deploy: recent[0] ?? null, recent });
}

describe("buildVersions", () => {
  it("numbers oldest-first so version 1 never changes number", () => {
    const versions = buildVersions(
      statusWithHistory([
        deployRow({ id: "d3", created_at: "2026-09-01T12:00:00Z" }),
        deployRow({ id: "d2", created_at: "2026-09-01T11:00:00Z" }),
        deployRow({ id: "d1", created_at: "2026-09-01T10:00:00Z" }),
      ]),
    );
    // Newest first for display, but the ordinal counts from the oldest row.
    expect(versions.map((v) => [v.id, v.ordinal])).toEqual([
      ["d3", 3],
      ["d2", 2],
      ["d1", 1],
    ]);
    expect(versions[0].label).toBe("Version 3");
  });

  it("is empty when nothing has ever deployed", () => {
    expect(buildVersions(null)).toEqual([]);
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-09-01T12:00:00Z");
  it("reads as plain English, never as a timestamp", () => {
    expect(relativeTime("2026-09-01T11:58:00Z", now)).toBe("2 minutes ago");
    expect(relativeTime("2026-09-01T09:00:00Z", now)).toBe("3 hours ago");
    expect(relativeTime("2026-08-30T12:00:00Z", now)).toBe("2 days ago");
    expect(relativeTime("2026-09-01T11:59:50Z", now)).toBe("just now");
  });
});
