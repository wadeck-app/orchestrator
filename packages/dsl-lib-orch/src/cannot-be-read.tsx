import React from 'react';
import { cannotBeReadMessage, type SourceFailure } from './source-failure.js';

/** The text a list shows in place of its "no data" text when its source failed. */
export function CannotBeRead({ failure }: { failure: SourceFailure }): React.ReactElement {
  return <p className="text-muted text-center py-12">{cannotBeReadMessage(failure)}</p>;
}
