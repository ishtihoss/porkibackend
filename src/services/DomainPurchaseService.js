const https = require('https');

const PORKBUN_API_BASE = 'https://api.porkbun.com/api/json/v3';

class DomainPurchaseService {
  constructor() {
    this.apiKey = process.env.PORKBUN_API_KEY;
    this.secretKey = process.env.PORKBUN_SECRET_KEY;
  }

  /**
   * Register a new domain via Porkbun API.
   * Returns: { success, domainId } or throws on failure.
   */
  async registerDomain(domain) {
    console.log(`🌐 Registering domain: ${domain}`);

    const result = await this._apiRequest(`/domain/register/${domain}`, {
      apikey: this.apiKey,
      secretapikey: this.secretKey,
      years: 1,
      // Porkbun uses account-level contact info for WHOIS
    });

    if (result.status !== 'SUCCESS') {
      throw new Error(`Domain registration failed: ${result.message || JSON.stringify(result)}`);
    }

    console.log(`�� Domain registered: ${domain}`);
    return { success: true, domainId: result.domain || domain };
  }

  /**
   * Update nameservers for a domain to point to Route 53.
   */
  async setNameservers(domain, nameservers) {
    console.log(`🔧 Setting nameservers for ${domain}:`, nameservers);

    const result = await this._apiRequest(`/domain/updateNs/${domain}`, {
      apikey: this.apiKey,
      secretapikey: this.secretKey,
      ns: nameservers,
    });

    if (result.status !== 'SUCCESS') {
      throw new Error(`Failed to update nameservers: ${result.message || JSON.stringify(result)}`);
    }

    console.log(`✅ Nameservers updated for ${domain}`);
    return { success: true };
  }

  /**
   * Renew a domain for another year.
   */
  async renewDomain(domain) {
    console.log(`🔄 Renewing domain: ${domain}`);

    const result = await this._apiRequest(`/domain/renew/${domain}`, {
      apikey: this.apiKey,
      secretapikey: this.secretKey,
      years: 1,
    });

    if (result.status !== 'SUCCESS') {
      throw new Error(`Domain renewal failed: ${result.message || JSON.stringify(result)}`);
    }

    console.log(`✅ Domain renewed: ${domain}`);
    return { success: true };
  }

  /**
   * Unlock domain and get auth/EPP code for transfer out.
   */
  async initiateTransfer(domain) {
    console.log(`🔓 Initiating transfer for: ${domain}`);

    // First unlock the domain
    const unlockResult = await this._apiRequest(`/domain/updateLock/${domain}`, {
      apikey: this.apiKey,
      secretapikey: this.secretKey,
      lock: 0, // 0 = unlocked
    });

    if (unlockResult.status !== 'SUCCESS') {
      throw new Error(`Failed to unlock domain: ${unlockResult.message || JSON.stringify(unlockResult)}`);
    }

    // Get the auth code
    const authResult = await this._apiRequest(`/domain/getAuthCode/${domain}`, {
      apikey: this.apiKey,
      secretapikey: this.secretKey,
    });

    if (authResult.status !== 'SUCCESS') {
      throw new Error(`Failed to get auth code: ${authResult.message || JSON.stringify(authResult)}`);
    }

    console.log(`✅ Transfer initiated for ${domain}`);
    return {
      success: true,
      authCode: authResult.authCode || authResult.code,
    };
  }

  /**
   * Get domain info (expiry date, status, etc.)
   */
  async getDomainInfo(domain) {
    const result = await this._apiRequest(`/domain/getDomain/${domain}`, {
      apikey: this.apiKey,
      secretapikey: this.secretKey,
    });

    if (result.status !== 'SUCCESS') {
      throw new Error(`Failed to get domain info: ${result.message || JSON.stringify(result)}`);
    }

    return {
      domain: result.domain,
      status: result.status,
      expireDate: result.expireDate,
      createDate: result.createDate,
      locked: result.locked,
    };
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
      req.setTimeout(30000, () => {
        req.destroy(new Error('Porkbun API request timed out'));
      });
      req.write(data);
      req.end();
    });
  }
}

module.exports = DomainPurchaseService;
