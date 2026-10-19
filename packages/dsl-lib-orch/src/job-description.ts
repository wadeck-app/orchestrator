/**
 * The first line of a job's description, for places that have room for one line (a card, a table row).
 * Undefined when there is nothing to show, so a caller renders no element rather than an empty one.
 *
 * Leading blank lines are skipped: the daemon trims the text, but a description from an older or
 * foreign source is not guaranteed to be.
 */
export function descriptionFirstLine(description: string | undefined): string | undefined {
  if (description === undefined) {
    return undefined;
  }
  const line = description.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
  return line;
}
