// Port concept of filter::smart_truncate (rtk/src/core/filter.rs).
// Keep HEAD + TAIL lines, replace middle with "... +N lines truncated".
import {
  SMART_TRUNCATE_HEAD, SMART_TRUNCATE_TAIL, SMART_TRUNCATE_MIN_LINES,
  SMART_TRUNCATE_MIN_BYTES, SMART_TRUNCATE_MAX_BYTES,
} from "../constants.js";

export function smartTruncate(input) {
  const lines = input.split("\n");

  // A minified JSON payload or a wall of prose is a single line however large it
  // is, so a line-count gate never fires on it and the whole blob goes upstream.
  if (lines.length < SMART_TRUNCATE_MIN_LINES) {
    if (input.length < SMART_TRUNCATE_MIN_BYTES) return input;
    const keep = Math.floor(SMART_TRUNCATE_MAX_BYTES / 2);
    const cut = input.length - keep * 2;
    if (cut <= 0) return input;
    return `${input.slice(0, keep)}\n... +${cut} characters truncated\n${input.slice(-keep)}`;
  }

  const head = lines.slice(0, SMART_TRUNCATE_HEAD);
  const tail = lines.slice(lines.length - SMART_TRUNCATE_TAIL);
  const cut = lines.length - head.length - tail.length;
  return [...head, `... +${cut} lines truncated`, ...tail].join("\n");
}

smartTruncate.filterName = "smart-truncate";
