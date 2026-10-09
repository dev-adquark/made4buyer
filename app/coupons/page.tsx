import type { Metadata } from "next";
import { prerenderNeedsDatabase } from "@/lib/public/isr";
import { DEFAULT_COUPONS_STATE } from "@/lib/public/listing-routes";
import { CouponsView, couponsMetadata } from "./coupons-view";

/**
 * All current coupons, page 1: static and cached (ISR, 5 minutes; the data is tagged "deals"). It never
 * reads the query string; `?page=` is rewritten by proxy.ts to v/[state] (cached per page).
 */
export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  await prerenderNeedsDatabase();
  return couponsMetadata(DEFAULT_COUPONS_STATE);
}

export default async function CouponsIndex() {
  await prerenderNeedsDatabase();
  return <CouponsView state={DEFAULT_COUPONS_STATE} />;
}
