process.env.DATABASE_URL = process.env.DB_URL;
process.env.DIRECT_URL = process.env.DB_URL;
process.env.APIFY_API_TOKEN = process.env.APIFY_TOKEN;
const { collectExternalScrape } = await import("./lib/commerce/pipeline.ts");
const r = await collectExternalScrape("cmvajtjlz00010p8ensii0w14", new Date());
console.log(JSON.stringify(r, null, 2));
process.exit(0);
