const LEVEL_MARKERS = [
  [/❌|\bERROR\b|\b\[error\]/i, "ERROR"],
  [/⚠️|\bWARN\b|\b\[warn\]/i, "WARN"],
  [/🔍|\bDEBUG\b|\b\[debug\]/i, "DEBUG"],
  [/ℹ️|\bINFO\b|\b\[info\]/i, "INFO"],
];

const LEVELS = new Set(["LOG", "INFO", "WARN", "ERROR", "DEBUG"]);

export function detectConsoleLogLevel(line) {
  for (const [pattern, level] of LEVEL_MARKERS) {
    if (pattern.test(line)) return level;
  }
  for (const token of line.match(/\[(\w+)\]/g) || []) {
    const inner = token.slice(1, -1).toUpperCase();
    if (LEVELS.has(inner)) return inner;
  }
  return "LOG";
}
