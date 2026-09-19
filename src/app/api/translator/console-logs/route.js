import { NextResponse } from "next/server";
import { clearConsoleLogs, getConsoleLogs, initConsoleLogCapture } from "@/lib/consoleLogBuffer";
import { isDistributed } from "@/lib/db/mode";

initConsoleLogCapture();

export async function GET() {
  try {
    // Distributed: the shared table is the only complete view — the in-process
    // buffer holds just this instance's lines.
    if (isDistributed()) {
      const { getRecentConsoleLogs, getConsoleLogInstances } = await import("@/lib/db/repos/consoleLogsRepo.js");
      const rows = await getRecentConsoleLogs(200);
      return NextResponse.json({
        success: true,
        logs: rows.map((r) => r.line),
        entries: rows,
        instances: await getConsoleLogInstances(),
      });
    }
    const logs = getConsoleLogs();
    return NextResponse.json({ success: true, logs });
  } catch (error) {
    console.error("Error getting console logs:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    clearConsoleLogs();
    if (isDistributed()) {
      const { clearConsoleLogsFromDb } = await import("@/lib/db/repos/consoleLogsRepo.js");
      await clearConsoleLogsFromDb();
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error clearing console logs:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
