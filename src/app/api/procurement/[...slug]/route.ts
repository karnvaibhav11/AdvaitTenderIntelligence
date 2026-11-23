import { handleProcurementRequest } from "@/modules/procurement/server/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ slug: string[] }> };

export async function GET(request: Request, { params }: Context) {
  return handleProcurementRequest(request, (await params).slug);
}

export async function POST(request: Request, { params }: Context) {
  return handleProcurementRequest(request, (await params).slug);
}
