#!/usr/bin/env node
// Standalone eBay scraper — run locally or via GitHub Actions
// Fetches sold listings for all portfolio cards and writes data/listings.json

const path = require("path");
const fs = require("fs");
const { fetchSoldListings, refreshSessionCookies } = require("../server");

async function main() {
  console.log("eBay Sold Listings Scraper");
  console.log("=========================\n");

  // Refresh session cookies (only matters in direct mode, no-op with ScraperAPI)
  await refreshSessionCookies();

  const portfolio = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "portfolio.json"), "utf8")
  );

  const results = {};
  let successCount = 0;

  for (let i = 0; i < portfolio.cards.length; i++) {
    const card = portfolio.cards[i];
    console.log(`[${i + 1}/${portfolio.cards.length}] ${card.name}`);

    try {
      const listings = await fetchSoldListings(card.query, {
        excludeTerms: card.excludeTerms || [],
        requireTerms: card.requireTerms || [],
        cardNumber: card.cardNumber || null,
        variant: card.variant !== undefined ? card.variant : null,
        autograph: card.autograph !== undefined ? card.autograph : null,
      });
      results[`card_${i}`] = {
        name: card.name,
        listings,
        fetchedAt: new Date().toISOString(),
      };
      successCount++;
      console.log(`  -> ${listings.length} listings\n`);
    } catch (err) {
      console.error(`  -> FAILED: ${err.message}\n`);
      // Don't include failed cards — previous data is preserved via merge below
    }

    // Rate-limit delay between cards
    if (i < portfolio.cards.length - 1) {
      const delay = process.env.SCRAPER_API_KEY ? 3000 : 2000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // Merge with existing data so failed cards keep their previous listings
  const dataDir = path.join(__dirname, "..", "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const dataPath = path.join(dataDir, "listings.json");
  let existing = {};
  if (fs.existsSync(dataPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(dataPath, "utf8")).cards || {};
    } catch {}
  }

  const merged = { ...existing, ...results };

  fs.writeFileSync(
    dataPath,
    JSON.stringify({ fetchedAt: new Date().toISOString(), cards: merged }, null, 2)
  );

  console.log(`Done: ${successCount}/${portfolio.cards.length} cards scraped`);
  console.log(`Wrote ${dataPath}`);

  if (successCount === 0) {
    console.error("\nAll cards failed!");
    console.error("If running in GitHub Actions, eBay may be blocking this runner's IP.");
    console.error("Try adding SCRAPER_API_KEY as a repository secret.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
