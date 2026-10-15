import { PageHeader } from '../../../components/ui/layout';
import { InlineAlert } from '../../../components/ui/feedback-v2';

/**
 * `team/page.tsx` calls `notFound()` for a non-admin (the e2e suite asserts the response is a
 * real 404, so that call stays), which otherwise renders Next's unstyled default 404 page inside
 * the console shell (brief defect #20). This gives that same status code a page consistent with
 * the rest of the console, using the exact copy `TeamView` already shows a signed-in non-admin
 * who reaches this route through the nav instead of a direct link.
 */
export default function TeamNotFound() {
  return (
    <div className="stack">
      <PageHeader eyebrow="Settings" title="Team" />
      <InlineAlert tone="danger">
        Team administration is available only to administrators of this organization.
      </InlineAlert>
    </div>
  );
}
