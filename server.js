const express = require("express");
const cheerio = require("cheerio");
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

function loadPortfolio() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "portfolio.json"), "utf8"));
}

// Per-card cache
const cache = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

app.get("/api/portfolio", (_req, res) => {
  try {
    const data = loadPortfolio();
    res.json({ success: true, portfolio: data });
  } catch (err) {
    console.error("Error reading portfolio:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fetch sold listings for a specific card by index
app.get("/api/sold-listings/:cardIndex", async (req, res) => {
  try {
    const portfolio = loadPortfolio();
    const idx = parseInt(req.params.cardIndex, 10);
    if (isNaN(idx) || idx < 0 || idx >= portfolio.cards.length) {
      return res.status(400).json({ success: false, error: "Invalid card index" });
    }

    const card = portfolio.cards[idx];
    const cacheKey = `card_${idx}`;
    const now = Date.now();

    if (cache[cacheKey] && now - cache[cacheKey].fetchedAt < CACHE_TTL) {
      return res.json({
        success: true,
        card: card.name,
        listings: cache[cacheKey].listings,
        cached: true,
      });
    }

    const listings = await fetchSoldListings(card.query, card.excludeTerms || []);
    cache[cacheKey] = { listings, fetchedAt: now };
    res.json({ success: true, card: card.name, listings });
  } catch (err) {
    console.error("Error fetching listings:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

async function fetchSoldListings(query, excludeTerms) {
  const encoded = encodeURIComponent(query);
  const url = `https://www.ebay.com/sch/i.html?_nkw=${encoded}&LH_Complete=1&LH_Sold=1&_sop=13&_ipg=120`;

  console.log("Launching browser to fetch:", url);

  const launchOptions = {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const browser = await puppeteer.launch(launchOptions);

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    await page.waitForSelector(".s-card", { timeout: 15000 }).catch(() => {
      console.log("No .s-card found, checking page state...");
    });

    const html = await page.content();
    console.log("Page loaded, HTML length:", html.length);

    const $ = cheerio.load(html);
    const listings = [];

    $(".s-card").each((_i, el) => {
      const $el = $(el);

      const title = $el.find(".s-card__title .su-styled-text").first().text().trim();
      if (!title || title === "Shop on eBay") return;

      // Filter out excluded terms
      const titleLower = title.toLowerCase();
      for (const term of excludeTerms) {
        if (titleLower.includes(term.toLowerCase())) return;
      }

      const link = $el.find("a.s-card__link[href*='/itm/']").attr("href") || "";
      const image = $el.find(".s-card__image").attr("src") || "";

      const priceText = $el.find(".s-card__price").text().trim();
      const priceMatch = priceText.match(/\$([\d,]+\.?\d*)/);
      const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, "")) : null;

      const attrTexts = [];
      $el.find(".s-card__attribute-row").each((_j, row) => {
        attrTexts.push($(row).text().trim());
      });
      const attrJoined = attrTexts.join(" | ");

      let shippingCost = null;
      let shippingText = null;
      for (const attr of attrTexts) {
        if (attr.toLowerCase().includes("delivery") || attr.toLowerCase().includes("shipping")) {
          shippingText = attr;
          if (attr.toLowerCase().includes("free")) {
            shippingCost = 0;
          } else {
            const shipMatch = attr.match(/\$([\d,]+\.?\d*)/);
            if (shipMatch) shippingCost = parseFloat(shipMatch[1].replace(/,/g, ""));
          }
          break;
        }
      }

      let dateSold = null;
      const captionText = $el.find(".s-card__caption .su-styled-text").text().trim();
      const dateMatch = captionText.match(
        /Sold\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s*\d{4})/i
      );
      if (dateMatch) {
        dateSold = dateMatch[1].trim();
      }

      let listingType = "Buy It Now";
      const lowerAttrs = attrJoined.toLowerCase();
      if (lowerAttrs.includes("bid")) {
        listingType = "Auction";
      } else if (lowerAttrs.includes("best offer")) {
        listingType = "Best Offer Accepted";
      }

      const bidsMatch = lowerAttrs.match(/(\d+)\s*bid/i);
      const bids = bidsMatch ? parseInt(bidsMatch[1], 10) : null;

      const condition = $el.find(".s-card__subtitle .su-styled-text").text().trim() || null;

      let seller = null;
      const sellerEl = $el.find(".su-card-container__attributes__secondary .s-card__attribute-row").first();
      if (sellerEl.length) {
        const sellerTexts = [];
        sellerEl.find(".su-styled-text").each((_j, st) => {
          sellerTexts.push($(st).text().trim());
        });
        seller = sellerTexts.filter(Boolean).join(" — ") || null;
      }

      let location = null;
      for (const attr of attrTexts) {
        if (attr.toLowerCase().startsWith("located in")) {
          location = attr;
          break;
        }
      }

      if (price !== null) {
        listings.push({
          title,
          price,
          shippingCost,
          shippingText,
          dateSold,
          listingType,
          bids,
          condition,
          seller,
          location,
          link: link ? link.split("?")[0] : "",
          image: image.includes("ebaystatic.com/rs/") ? "" : image,
        });
      }
    });

    console.log(`Parsed ${listings.length} sold listings for "${query}"`);
    return listings;
  } finally {
    await browser.close();
  }
}

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
