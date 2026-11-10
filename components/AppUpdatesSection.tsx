"use client";

import { useEffect, useState } from "react";
import { APP_VERSION, APP_VERSION_DISPLAY } from "@/lib/branding";
import { formatBuildLabel, type AppInfo } from "@/lib/app-build-info";
import { useI18n } from "@/hooks/useI18n";

/**
 * "Version" for the packaged desktop distribution.
 *
 * There is no update check: this build is distributed by hand, so a card that
 * asked GitHub whether something newer exists only ever answered "you're on the
 * latest version" — a line that says nothing and a request that costs something.
 *
 * What is left is the fact support actually asks for, and since SSR-000096 it
 * has to identify the build, not just the release: `0.8.2 · e0a8022`, with
 * `+dirty` when the package came from an uncommitted tree. The value comes from
 * `GET /api/app-info` — the same manifest read — so the interface can never
 * show a commit the API would not return. Before the first response (and in a
 * plain browser, where there is no packaged manifest) it falls back to the
 * product version alone.
 */
export function AppUpdatesSection() {
  const { t } = useI18n();
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/app-info", { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as AppInfo;
        if (!cancelled) setInfo(payload);
      } catch {
        // No build identity available; the version alone is still true.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const label = info
    ? formatBuildLabel(info, displayVersion(info.appVersion))
    : APP_VERSION_DISPLAY || APP_VERSION;
  const build = info?.build ?? null;

  return (
    <section className="settings-general-section settings-updates">
      <h3 className="settings-general-heading">{t("appSettings.updatesSection")}</h3>
      <div className="settings-update-card">
        <dl className="settings-update-versions">
          <div className="settings-update-row">
            <dt>{t("appSettings.currentVersion")}</dt>
            <dd
              title={build
                ? [
                  `commit ${build.gitCommit}`,
                  `branch ${build.gitBranch}`,
                  `built ${build.builtAt}`,
                  `node ${build.node}`,
                  build.buildId ? `next build ${build.buildId}` : null,
                ].filter(Boolean).join("\n")
                : undefined}
            >
              {`v${label}`}
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function displayVersion(version: string) {
  return version.endsWith(".0") ? version.slice(0, -2) : version;
}
