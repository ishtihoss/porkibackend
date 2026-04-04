const https = require('https');

const PORKBUN_API_BASE = 'https://api.porkbun.com/api/json/v3';

// Popular TLDs to check when user searches
const SUGGESTED_TLDS = ['.com', '.io', '.dev', '.org', '.net', '.co', '.app', '.xyz'];

// Cache pricing for 5 minutes to reduce API calls
const PRICE_CACHE_TTL = 5 * 60 * 1000;

class DomainSearchService {
  constructor() {
    this.apiKey = process.env.PORKBUN_API_KEY;
    this.secretKey = process.env.PORKBUN_SECRET_KEY;
    this._priceCache = new Map();
  }

  /**
   * Search for domain availability and pricing.
   * If query includes a TLD (e.g. "mysite.com"), check that specific domain.
   * If no TLD, check across popular TLDs.
   * Returns: { results: [{ domain, available, price, currency, tld }] }
   */
  async search(query) {
    const cleaned = query.trim().toLowerCase().replace(/[^a-z0-9.-]/g, '');
    if (!cleaned) {
      return { results: [], error: 'Invalid search query' };
    }

    const hasTld = cleaned.includes('.');
    const domainsToCheck = hasTld
      ? [cleaned]
      : SUGGESTED_TLDS.map(tld => cleaned + tld);

    const results = await Promise.allSettled(
      domainsToCheck.map(domain => this._checkAvailability(domain))
    );

    const output = results
      .map((result, i) => {
        if (result.status === 'fulfilled') return result.value;
        console.error(`Failed to check ${domainsToCheck[i]}:`, result.reason?.message);
        return null;
      })
      .filter(Boolean);

    // Sort: available first, then by price ascending
    output.sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      return (a.price || Infinity) - (b.price || Infinity);
    });

    return { results: output };
  }

  /**
   * Check availability and pricing for a single domain.
   */
  async _checkAvailability(domain) {
    // Check price cache first
    const cached = this._priceCache.get(domain);
    if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL) {
      return cached.data;
    }

    const body = {
      apikey: this.apiKey,
      secretapikey: this.secretKey,
    };

    // Porkbun domain pricing endpoint
    const tld = domain.substring(domain.indexOf('.') + 1);
    let price = null;
    let renewalPrice = null;

    try {
      const pricingData = await this._apiRequest('/pricing/get', body);
      if (pricingData.status === 'SUCCESS' && pricingData.pricing?.[tld]) {
        price = parseFloat(pricingData.pricing[tld].registration);
        renewalPrice = parseFloat(pricingData.pricing[tld].renewal);
      }
    } catch (err) {
      console.error(`Pricing fetch failed for ${tld}:`, err.message);
    }

    // Check availability via Porkbun's check endpoint
    let available = false;
    try {
      const checkData = await this._apiRequest(`/domain/checkDomain/${domain}`, body);
      // Porkbun returns status: "SUCCESS" with avail: true/false
      // or sometimes the response indicates availability differently
      available = checkData.status === 'SUCCESS' &&
        (checkData.avail === true || checkData.avail === 'true' || checkData.your_response === 'Domain is available');
    } catch (err) {
      console.error(`Availability check failed for ${domain}:`, err.message);
    }

    const result = {
      domain,
      tld,
      available,
      price,
      renewalPrice,
      currency: 'USD',
    };

    // Cache the result
    this._priceCache.set(domain, { data: result, timestamp: Date.now() });

    return result;
  }

  /**
   * Get markup price (our price to the user).
   */
  getMarkupPrice(wholesalePrice) {
    const markupPercent = parseInt(process.env.DOMAIN_MARKUP_PERCENT || '20', 10);
    return Math.ceil(wholesalePrice * (1 + markupPercent / 100) * 100); // cents
  }

  /**
   * Make a request to the Porkbun API.
   */
  _apiRequest(endpoint, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const url = new URL(PORKBUN_API_BASE + endpoint);

      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      };

      const req = https.request(options, (res) => {
        let responseData = '';
        res.on('data', chunk => { responseData += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(responseData));
          } catch (e) {
            reject(new Error(`Invalid JSON response from Porkbun: ${responseData.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => {
        req.destroy(new Error('Porkbun API request timed out'));
      });
      req.write(data);
      req.end();
    });
  }
}

module.exports = DomainSearchService;
