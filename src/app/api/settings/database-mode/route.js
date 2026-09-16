import { NextResponse } from "next/server";
import { describeDatabase } from "@/lib/db/mode";
import { getRequestIdentity, isScopeEnabled } from "@/lib/auth/resourceScope";
import { getSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// Which database this instance is using. describeDatabase() already omits the
// password and the raw URL, but host and user still describe infrastructure, so
// the detail stays with the admin while everyone can see the mode.
export async function GET() {
  try {
    const info = describeDatabase();
    const settings = await getSettings();
    if (isScopeEnabled(settings) && !(await getRequestIdentity()).isAdmin) {
      return NextResponse.json({ mode: info.mode, label: info.label });
    }
    return NextResponse.json(info);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
