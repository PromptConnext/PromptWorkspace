"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { siteConfig } from "@/lib/site";

type OS = "mac" | "windows" | "linux";

const platforms: { os: OS; label: string; file: string; note: string }[] = [
  { os: "mac", label: "macOS", file: "PromptConnext.dmg", note: "Apple silicon & Intel · macOS 12+" },
  { os: "windows", label: "Windows", file: "PromptConnext-Setup.exe", note: "Windows 10/11 · x64" },
  { os: "linux", label: "Linux", file: "PromptConnext.AppImage", note: "AppImage · x64" },
];

function detectOS(): OS {
  if (typeof navigator === "undefined") return "mac";
  const p = navigator.platform.toLowerCase();
  const ua = navigator.userAgent.toLowerCase();
  if (p.includes("win") || ua.includes("windows")) return "windows";
  if (p.includes("linux") || ua.includes("linux")) return "linux";
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

        <div className="grid gap-4 sm:grid-cols-3">
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
          <Button href={`${baseUrl}/v${version}/${primary.file}`} size="lg">
            {t("downloadFor", { platform: primary.label })}
          </Button>
        </div>
        <p className="mt-3 text-xs text-text-tertiary">
          {t("versionFree", { version })} · {primary.note}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {platforms.map((p) => (
          <Card key={p.os}>
            <CardTitle>{p.label}</CardTitle>
            <CardDescription>{p.note}</CardDescription>
            <div className="mt-4">
              <Button href={`${baseUrl}/v${version}/${p.file}`} variant="secondary" size="sm">
                {t("download")}
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
