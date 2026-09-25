export const routes = {
  legacyPaths: { '/twilio/media': 'media' },
};
// Known violation: `legacyPaths` appears only inside another identifier on one line and only in a
// trailing comment on the other, so neither line is allowlisted and both vendor names count.
export const legacyPathsHelper = 'twilio';
export const carrier = 'plivo'; // legacyPaths
