'use client';
// Internal component-library fixture page. Not linked from the sidebar; reached by typing the
// URL. Screen-rebuild agents use it as a live reference for every W14 primitive before wiring
// real API data to it. See /tmp/ovo-ui/components.md for the usage guide. Split across
// `sections-*.tsx` to satisfy the module-size gate.
import { PageHeader } from '../../../components/ui/layout';
import { StatusBadgeV2 } from '../../../components/ui/status-badge';
import { ThemeToggle } from '../../../components/ui/theme-toggle';
import { ChartsSection } from './sections-d';
import { FeedbackAndFormSections } from './sections-b';
import { MediaSection } from './sections-c';
import { TokensAndDataSections } from './sections-a';

export default function DesignSystemPage() {
  return (
    <div className="content">
      {/* No `breadcrumb` here: this route sits inside the shared console layout, whose topbar
          already renders its own "OVO / <label>" trail. Passing one duplicated it ("OVO / OVO"
          plus "Design system" — the topbar's label lookup has no entry for this route and falls
          back to "OVO"). A real screen adopting `PageHeader`'s breadcrumb needs the topbar's own
          trail retired first; see components.md. */}
      <PageHeader
        title="Design system"
        eyebrow="Internal"
        description="Every W14 primitive, live. Not part of the product nav."
        actions={<ThemeToggle />}
        meta={<StatusBadgeV2 value="healthy" />}
        onRefresh={() => undefined}
      />
      <TokensAndDataSections />
      <FeedbackAndFormSections />
      <MediaSection />
      <ChartsSection />
    </div>
  );
}
