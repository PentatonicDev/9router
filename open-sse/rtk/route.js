import { autoDetectFilter } from "./autodetect.js";
import { MIN_COMPRESS_SIZE } from "./constants.js";

// Blobs this large with no structure the RTK recognises are what Headroom is
// actually good at: it summarises prose, JSON and markup semantically, where a
// line-based truncation would just cut them off mid-thought.
export const SEMANTIC_MIN_BYTES = 4 * 1024;

const RE_JSON = /^\s*[[{][\s\S]*[\]}]\s*$/;
const RE_MARKUP = /<\/?[a-z][^>]*>/i;

/**
 * Which compressor should own a tool_result block.
 *
 * The two overlap: both target tool output, RTK runs first, and whatever it
 * rewrites reaches Headroom already small — so the second pass pays latency for
 * little gain. Routing each block to one of them keeps each doing what it is
 * good at: RTK reshapes *structured* output (git, grep, ls, tree, logs) losslessly
 * in-process, Headroom compresses *unstructured* text, which RTK cannot read.
 *
 * Returns "rtk" | "headroom" | "none".
 */
export function routeBlock(text, { rtkEnabled = true, headroomEnabled = false } = {}) {
  if (typeof text !== "string" || text.length < MIN_COMPRESS_SIZE) return "none";

  const structured = rtkEnabled ? autoDetectFilter(text) : null;
  // dedupLog and smartTruncate are RTK's generic last resorts, not real structure;
  // when Headroom is available it reads such text better than a line heuristic.
  const genericFallback = structured
    && ["dedup-log", "smart-truncate"].includes(structured.filterName || "");

  if (structured && !genericFallback) return "rtk";

  if (headroomEnabled && text.length >= SEMANTIC_MIN_BYTES && looksSemantic(text)) return "headroom";

  return structured ? "rtk" : "none";
}

// Prose, JSON and markup carry meaning a line-based filter cannot compress
// without destroying it; everything else stays with RTK's heuristics.
function looksSemantic(text) {
  const head = text.slice(0, 2048);
  if (RE_JSON.test(text.slice(0, 200) + text.slice(-200))) return true;
  if (RE_MARKUP.test(head)) return true;
  // Long lines with sentence punctuation read as prose rather than machine output.
  const lines = head.split("\n");
  const avgLen = head.length / Math.max(lines.length, 1);
  return avgLen > 120 && /[.!?]\s/.test(head);
}
