import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { withApiError } from "@/lib/api-error";
import { newTraceId } from "@/lib/logger";
import { CreditBalanceResponseSchema } from "@/contracts/credits";

export async function GET() {
  const traceId = newTraceId();
  return withApiError({ traceId }, async () => {
    const user = await requireUser();
    const body = CreditBalanceResponseSchema.parse({ balance: user.creditBalance });
    return NextResponse.json(body);
  });
}
