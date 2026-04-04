const https = require('https');

const PORKBUN_API_BASE = 'https://api.porkbun.com/api/json/v3';

// Popular TLDs to check when user searches (ordered by popularity)
const SUGGESTED_TLDS = ['.com', '.org', '.net', '.io', '.dev', '.co', '.app', '.xyz'];

// Cache results for 5 minutes
const CACHE_TTL = 5 * 60 * 1000;

class DomainSearchService {
  constructor() {
    this.apiKey = process.env.PORKBUN_API_KEY;
    this.secretKey = process.env.PORKBUN_SECRET_KEY;
    this._cache = new Map();
  }

  /**
   * Search for domain availability and pricing.
   * If query includes a TLD (e.g. "mysite.com"), check that specific domain.
   * If no TLD, check across popular TLDs.
   *
   * Porkbun rate-limits checkDomain to 1 request per 10 seconds,
   * so we run checks sequentially with a delay between each.
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

    const results = [];

    for (const domain of domainsToCheck) {
      try {
        const result = await this._checkAvailability(domain);
        results.push(result);
      } catch (err) {
        console.error(`Failed to check ${domain}:`, err.message);
      }
    }

    // Sort: available first, then by price ascending
    results.sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      return (a.price || Infinity) - (b.price || Infinity);
    });

    return { results };
  }

  /**
   * Check availability and pricing for a single domain.
   * Porkbun's checkDomain endpoint returns availability AND pricing in one call.
   */
  async _checkAvailability(domain) {
    // Check cache first
    const cached = this._cache.get(domain);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    const tld = domain.substring(domain.indexOf('.') + 1);

    const response = await this._apiRequest(`/domain/checkDomain/${domain}`, {
      apikey: this.apiKey,
      secretapikey: this.secretKey,
    });

    // Response format:
    // { status: "SUCCESS", response: { avail: "yes"|"no", price: "11.08", additional: { renewal: { price: "11.08" } } } }
    const available = response.status === 'SUCCESS' && response.response?.avail === 'yes';
    const price = response.response?.price ? parseFloat(response.response.price) : null;
    const renewalPrice = response.response?.additional?.renewal?.price
      ? parseFloat(response.response.additional.renewal.price)
      : price;

    const result = {
      domain,
      tld,
      available,
      price,
      renewalPrice,
      currency: 'USD',
    };

    this._cache.set(domain, { data: result, timestamp: Date.now() });
    return result;
  }

  /**
   * Get markup price in cents (our price to the user).
   */
  getMarkupPrice(wholesalePrice) {
    const markupPercent = parseInt(process.env.DOMAIN_MARKUP_PERCENT || '20', 10);
    return Math.ceil(wholesalePrice * (1 + markupPercent / 100) * 100);
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
            reject(new Error(`Invalid JSON from Porkbun: ${responseData.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(20000, () => {
        req.destroy(new Error('Porkbun API request timed out'));
      });
      req.write(data);
      req.end();
    });
  }
}

module.exports = DomainSearchService;
