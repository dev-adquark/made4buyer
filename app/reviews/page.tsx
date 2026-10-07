import type { Metadata } from "next";
import { DEFAULT_REVIEWS_STATE } from "@/lib/public/listing-routes";
import { prerenderNeedsDatabase } from "@/lib/public/isr";
import { ReviewsView, reviewsMetadata } from "./reviews-view";

/**
 * All reviews, newest first: static and cached (ISR, 5 minutes, purged on publish). It never reads
 * the query string; `?type=` and `?page=` are rewritten by proxy.ts to v/[state] (cached per state).
 */
export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  await prerenderNeedsDatabase();
  return reviewsMetadata(DEFAULT_REVIEWS_STATE);
}

export default async function ReviewsIndex() {
  await prerenderNeedsDatabase();
  return <ReviewsView state={DEFAULT_REVIEWS_STATE} />;
}
