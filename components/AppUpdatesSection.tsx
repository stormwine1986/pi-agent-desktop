"use client";

import { APP_VERSION, APP_VERSION_DISPLAY } from "@/lib/branding";
import { useI18n } from "@/hooks/useI18n";

/**
 * "Version" for the packaged desktop distribution.
 *
 * There is no update check: this build is distributed by hand, so a card that
 * asked GitHub whether something newer exists only ever answered "you're on the
 * latest version" — a line that says nothing and a request that costs something.
 * What is left is the one fact support actually asks for.
 */
export function AppUpdatesSection() {
  const { t } = useI18n();

  return (
    <section className="settings-general-section settings-updates">
      <h3 className="settings-general-heading">{t("appSettings.updatesSection")}</h3>
      <div className="settings-update-card">
        <dl className="settings-update-versions">
          <div className="settings-update-row">
            <dt>{t("appSettings.currentVersion")}</dt>
            <dd>{`v${APP_VERSION_DISPLAY || APP_VERSION}`}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
