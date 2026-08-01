"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { siteConfig } from "@/lib/site";

type OS = "mac" | "windows";

// Filenames must match what apps/desktop CI publishes to the R2 download host.
// tauri bundle targets are ["app", "nsis"] with productName "PromptConnext":
//   macOS   — the .app dir is zipped by the release workflow -> PromptConnext.app.zip
//   Windows — NSIS installer, published under its versioned name AND copied to
//             a version-free alias by the release workflow's upload step.
// Both names are therefore version-stable, and this page never has to be
// redeployed for a version bump: installed apps update themselves from
// latest.json, and these links always resolve to whatever CI published last.
const platforms: { os: OS; label: string; note: string; file: string }[] = [
  { os: "mac", label: "macOS", note: "Apple silicon · macOS 12+", file: "PromptConnext.app.zip" },
  { os: "windows", label: "Windows", note: "Windows 10/11 · x64", file: "PromptConnext_x64-setup.exe" },
];

function detectOS(): OS {
  if (typeof navigator === "undefined") return "mac";
  const p = navigator.platform.toLowerCase();
  const ua = navigator.userAgent.toLowerCase();
  if (p.includes("win") || ua.includes("windows")) return "windows";
  return "mac";
}

export function DownloadOptions() {
  const t = useTranslations("download");
  const [os, setOs] = useState<OS>("mac");
  const { version, baseUrl, available } = siteConfig.download;

  useEffect(() => {
    setOs(detectOS());
  }, []);

  // Pre-release: no download host configured yet.
  if (!available) {
    return (
      <div className="flex flex-col gap-8">
        <div className="hero-glow rounded-xl border border-border-default bg-surface-muted p-8 text-center">
          <Badge className="mb-4">{t("comingSoonBadge")}</Badge>
          <h2 className="text-2xl font-semibold text-text-primary">{t("comingSoonTitle")}</h2>
          <p className="mx-auto mt-3 max-w-md text-sm text-text-secondary">{t("comingSoonNote")}</p>
          <div className="mt-6">
            <Button href="/contact" size="lg">
              {t("comingSoonCta")}
            </Button>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {platforms.map((p) => (
            <Card key={p.os}>
              <CardTitle>{p.label}</CardTitle>
              <CardDescription>{p.note}</CardDescription>
              <div className="mt-4">
                <Button variant="secondary" size="sm" disabled>
                  {t("comingSoonLabel")}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const primary = platforms.find((p) => p.os === os) ?? platforms[0];

  return (
    <div className="flex flex-col gap-8">
      <div className="hero-glow rounded-xl border border-border-default bg-surface-muted p-8 text-center">
        <p className="text-sm text-text-tertiary">
          {t("detected")}: {primary.label}
        </p>
        <div className="mt-4">
          <Button href={`${baseUrl}/${primary.file}`} size="lg">
            {t("downloadFor", { platform: primary.label })}
          </Button>
        </div>
        <p className="mt-3 text-xs text-text-tertiary">
          {version ? t("versionFree", { version }) : t("free")} · {primary.note}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {platforms.map((p) => (
          <Card key={p.os}>
            <CardTitle>{p.label}</CardTitle>
            <CardDescription>{p.note}</CardDescription>
            <div className="mt-4">
              <Button href={`${baseUrl}/${p.file}`} variant="secondary" size="sm">
                {t("download")}
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
