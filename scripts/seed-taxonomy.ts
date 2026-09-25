/** Upserts the taxonomy (categories, subcategories, intents, platforms, price tiers) into category_tags. */
import "./support/load-env";
import { db } from "@/lib/db";
import { seedTaxonomy } from "@/lib/taxonomy/persist";

seedTaxonomy()
  .then(async () => console.log(`category_tags: ${await db.categoryTag.count()} rows`))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
