const express = require("express");
const cheerio = require("cheerio");
const https = require("https");
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
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// Concurrency-limited queue — 2 simultaneous eBay fetches (avoids rate limiting)
const MAX_CONCURRENT = 2;
let activeCount = 0;
const waitQueue = [];

function queueFetch(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeCount++;
      fn().then(resolve, reject).finally(() => {
        activeCount--;
        if (waitQueue.length > 0) waitQueue.shift()();
      });
    };
    if (activeCount < MAX_CONCURRENT) {
      run();
    } else {
      waitQueue.push(run);
    }
  });
}

// Deduplicated fetch — pre-warming and user requests share the same in-flight promise
const inFlight = new Map();

function fetchCardListings(card, cacheKey) {
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const doFetch = () => queueFetch(() =>
    fetchSoldListings(card.query, {
      excludeTerms: card.excludeTerms || [],
      requireTerms: card.requireTerms || [],
      cardNumber: card.cardNumber || null,
      variant: card.variant !== undefined ? card.variant : null,
      autograph: card.autograph !== undefined ? card.autograph : null,
    })
  );

  const promise = doFetch()
    .catch(err => {
      // Retry once after 5s if eBay rate-limited us
      if (err.message === "RATE_LIMITED") {
        console.warn(`Rate limited on ${card.name}, retrying in 5s...`);
        return new Promise(r => setTimeout(r, 5000)).then(doFetch);
      }
      throw err;
    })
    .then(listings => {
      cache[cacheKey] = { listings, fetchedAt: Date.now() };
      inFlight.delete(cacheKey);
      return listings;
    })
    .catch(err => {
      inFlight.delete(cacheKey);
      throw err;
    });

  inFlight.set(cacheKey, promise);
  return promise;
}

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

    // Serve from cache if fresh
    if (cache[cacheKey] && Date.now() - cache[cacheKey].fetchedAt < CACHE_TTL) {
      return res.json({ success: true, card: card.name, listings: cache[cacheKey].listings, cached: true });
    }

    const listings = await fetchCardListings(card, cacheKey);
    res.json({ success: true, card: card.name, listings });
  } catch (err) {
    console.error("Error fetching listings:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Detect bundle/lot listings — (2), (3), "x2", "lot", etc.
const BUNDLE_PATTERN = /^\s*\(\d+\)|\(\d+\)\s|x\s*\d{2,}|\b\d+\s*card\s*lot\b|\blot\b|\bbundle\b|\bset of\b/i;
function isBundleListing(title) {
  return BUNDLE_PATTERN.test(title);
}

// Variant-related terms — used when card.variant === false to filter out parallels/inserts
const VARIANT_TERMS = [
  "refractor", "xfractor", "superfractor",
  "variation", "short print",
  "mojo", "prism", "prizm",
  "shimmer", "atomic", "sapphire",
  "camo", "sepia", "negative",
  "printing plate", "vintage stock",
  "parallel", "mini diamond",
];
// Short abbreviations need word-boundary matching to avoid false positives
// "SP" — short print (avoid matching "PSA", "SPORTS")
// "VAR" — variation abbreviation (avoid matching "various", etc.)
const VARIANT_ABBREV_PATTERN = /\bSP\b|\bVAR\b/i;

function isVariantListing(title) {
  const lower = title.toLowerCase();
  for (const term of VARIANT_TERMS) {
    if (lower.includes(term)) return true;
  }
  // Check for short abbreviations with word boundaries
  if (VARIANT_ABBREV_PATTERN.test(title)) return true;
  return false;
}

// Autograph-related terms — used when card.autograph === false
const AUTOGRAPH_TERMS = ["auto", "autograph", "signed", "signature"];

function isAutographListing(title) {
  const lower = title.toLowerCase();
  for (const term of AUTOGRAPH_TERMS) {
    if (lower.includes(term)) return true;
  }
  return false;
}

// Match card number in title with smart regex
// Numeric cards (e.g. "1"): require # prefix so #1 matches but #10 or #1b doesn't
// Alphanumeric cards (e.g. "HMT55"): match with or without # prefix
function matchesCardNumber(title, cardNumber) {
  if (!cardNumber) return true;
  const escaped = cardNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startsWithLetter = /^[a-zA-Z]/.test(cardNumber);
  let pattern;
  if (startsWithLetter) {
    pattern = new RegExp(`(?:#)?${escaped}(?!\\w)`, "i");
  } else {
    // Use (?!\w) to block both digits (#10) and letter suffixes (#1b SP variants)
    pattern = new RegExp(`#${escaped}(?!\\w)`, "i");
  }
  return pattern.test(title);
}

// Fetch a URL via HTTPS with browser-like headers, returns HTML string
function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "identity",
      },
    }, (res) => {
      // Detect eBay bot-detection challenge
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (res.headers.location.includes("challenge") || res.headers.location.includes("captcha")) {
          reject(new Error("RATE_LIMITED"));
          return;
        }
        // Follow normal redirects
        fetchPage(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`eBay returned HTTP ${res.statusCode}`));
        return;
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("eBay request timed out after 15s"));
    });
  });
}

async function fetchSoldListings(query, { excludeTerms, requireTerms, cardNumber, variant, autograph }) {
  const encoded = encodeURIComponent(query);
  const url = `https://www.ebay.com/sch/i.html?_nkw=${encoded}&LH_Complete=1&LH_Sold=1&_sop=13&_ipg=120`;

  console.log("Fetching:", url);

  const html = await fetchPage(url);
  console.log("Page fetched, HTML length:", html.length);

  const $ = cheerio.load(html);
  const listings = [];

  $(".s-card").each((_i, el) => {
    const $el = $(el);

    const title = $el.find(".s-card__title .su-styled-text").first().text().trim();
    if (!title || title === "Shop on eBay") return;

    // Filter out excluded terms (card-specific blacklist)
    const titleLower = title.toLowerCase();
    for (const term of excludeTerms) {
      if (titleLower.includes(term.toLowerCase())) return;
    }

    // Require all terms in requireTerms to be present (whitelist)
    if (requireTerms.length > 0) {
      for (const term of requireTerms) {
        if (!titleLower.includes(term.toLowerCase())) return;
      }
    }

    // Filter out variants when the card is NOT a variant
    if (variant === false && isVariantListing(title)) return;

    // Filter out autographs when the card is NOT an autograph
    if (autograph === false && isAutographListing(title)) return;

    // Require card number match if specified
    if (!matchesCardNumber(title, cardNumber)) return;

    // Filter out bundle/lot listings (multiple cards sold together)
    if (isBundleListing(title)) return;

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
}

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);

  // Pre-warm cache on startup so first visitor gets instant results
  try {
    const portfolio = loadPortfolio();
    console.log(`Pre-warming cache for ${portfolio.cards.length} cards...`);
    // Stagger pre-warming requests to avoid eBay rate limiting
    portfolio.cards.forEach((card, idx) => {
      setTimeout(() => {
        fetchCardListings(card, `card_${idx}`)
          .then(listings => console.log(`Cached: ${card.name} (${listings.length} listings)`))
          .catch(err => console.error(`Cache warm failed for ${card.name}:`, err.message));
      }, idx * 1500); // 1.5s between each card start
    });
  } catch (err) {
    console.error("Failed to start cache warming:", err.message);
  }
});
