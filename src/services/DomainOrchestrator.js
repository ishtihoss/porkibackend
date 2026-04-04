const { createClient } = require('@supabase/supabase-js');
const DomainPurchaseService = require('./DomainPurchaseService');
const DomainInfraService = require('./DomainInfraService');

/**
 * Orchestrates the full domain provisioning pipeline as a state machine.
 * Each step is idempotent — if the process fails midway, retrying
 * resumes from the last successful step.
 *
 * Status flow:
 *   payment_pending → registering → configuring_dns → issuing_cert
 *   → deploying_cdn → active
 *
 * Emits progress events via SSE to connected clients.
 */

const STEPS = [
  'registering',
  'configuring_dns',
  'issuing_cert',
  'deploying_cdn',
  'active',
];

class DomainOrchestrator {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    this.purchaseService = new DomainPurchaseService();
    this.infraService = new DomainInfraService();

    // SSE connections: domainId -> [res objects]
    this._sseClients = new Map();
  }

  /**
   * Start the full provisioning pipeline for a domain.
   * Called after Stripe payment is confirmed.
   */
  async startProvisioning(domainId) {
    const domain = await this._getDomain(domainId);
    if (!domain) {
      throw new Error(`Domain record not found: ${domainId}`);
    }

    console.log(`🚀 Starting provisioning for ${domain.domain} (status: ${domain.status})`);

    try {
      // Resume from current status
      const startIndex = this._getResumeIndex(domain.status);

      for (let i = startIndex; i < STEPS.length; i++) {
        const step = STEPS[i];
        await this._updateStatus(domainId, step);
        this._emitProgress(domainId, step, i, STEPS.length);

        switch (step) {
          case 'registering':
            await this._stepRegister(domainId, domain);
            break;
          case 'configuring_dns':
            await this._stepConfigureDns(domainId, domain);
            break;
          case 'issuing_cert':
            await this._stepIssueCert(domainId, domain);
            break;
          case 'deploying_cdn':
            await this._stepDeployCdn(domainId, domain);
            break;
          case 'active':
            await this._stepActivate(domainId, domain);
            break;
        }

        // Re-fetch domain after each step (it may have been updated)
        domain = await this._getDomain(domainId);
      }

      console.log(`✅ Provisioning complete for ${domain.domain}`);
    } catch (err) {
      console.error(`❌ Provisioning failed for domain ${domainId} at step:`, err.message);
      this._emitProgress(domainId, 'error', -1, STEPS.length, err.message);
      throw err;
    }
  }

  // ── Pipeline Steps ────────────────────────────────────────────────────

  async _stepRegister(domainId, domain) {
    console.log(`  Step 1: Registering domain ${domain.domain}`);

    const result = await this.purchaseService.registerDomain(domain.domain);

    await this._updateDomain(domainId, {
      porkbun_domain_id: result.domainId,
      domain_registered_at: new Date().toISOString(),
    });
  }

  async _stepConfigureDns(domainId, domain) {
    console.log(`  Step 2: Configuring DNS for ${domain.domain}`);

    // Create Route 53 hosted zone
    let hostedZoneId = domain.route53_hosted_zone_id;
    let nameservers = domain.route53_nameservers;

    if (!hostedZoneId) {
      const zoneResult = await this.infraService.createHostedZone(domain.domain);
      hostedZoneId = zoneResult.hostedZoneId;
      nameservers = zoneResult.nameservers;

      await this._updateDomain(domainId, {
        route53_hosted_zone_id: hostedZoneId,
        route53_nameservers: nameservers,
      });
    }

    // Set nameservers at Porkbun to point to Route 53
    await this.purchaseService.setNameservers(domain.domain, nameservers);
  }

  async _stepIssueCert(domainId, domain) {
    console.log(`  Step 3: Issuing SSL certificate for ${domain.domain}`);

    // Request certificate if we don't have one yet
    let certArn = domain.acm_certificate_arn;

    if (!certArn) {
      const certResult = await this.infraService.requestCertificate(domain.domain);
      certArn = certResult.certificateArn;

      await this._updateDomain(domainId, {
        acm_certificate_arn: certArn,
      });
    }

    // Wait for validation records to become available (ACM needs a moment)
    await this._sleep(5000);

    // Get and add DNS validation records
    const validationRecords = await this._pollForValidationRecords(certArn);

    if (validationRecords.length > 0) {
      const hostedZoneId = domain.route53_hosted_zone_id ||
        (await this._getDomain(domainId)).route53_hosted_zone_id;

      await this.infraService.addDnsRecords(hostedZoneId, validationRecords);
    }

    // Poll until certificate is issued (can take 1-5 minutes)
    await this._pollCertificateStatus(certArn);

    await this._updateDomain(domainId, {
      cert_issued_at: new Date().toISOString(),
    });
  }

  async _stepDeployCdn(domainId, domain) {
    console.log(`  Step 4: Deploying CloudFront distribution for ${domain.domain}`);

    let distributionId = domain.cloudfront_distribution_id;

    if (!distributionId) {
      const certArn = domain.acm_certificate_arn ||
        (await this._getDomain(domainId)).acm_certificate_arn;

      const distResult = await this.infraService.createDistribution(
        domain.domain,
        domain.subdomain,
        certArn
      );

      distributionId = distResult.distributionId;

      await this._updateDomain(domainId, {
        cloudfront_distribution_id: distResult.distributionId,
        cloudfront_domain_name: distResult.domainName,
      });

      // Add Route 53 alias records pointing to CloudFront
      const hostedZoneId = domain.route53_hosted_zone_id ||
        (await this._getDomain(domainId)).route53_hosted_zone_id;

      await this.infraService.addCloudFrontAliasRecords(
        hostedZoneId,
        domain.domain,
        distResult.domainName
      );
    }

    // Poll until CloudFront is deployed (can take 5-15 minutes)
    await this._pollDistributionStatus(distributionId);
  }

  async _stepActivate(domainId, domain) {
    console.log(`  Step 5: Activating ${domain.domain}`);

    // Get domain expiry info from Porkbun
    try {
      const info = await this.purchaseService.getDomainInfo(domain.domain);
      if (info.expireDate) {
        await this._updateDomain(domainId, {
          domain_expires_at: new Date(info.expireDate).toISOString(),
        });
      }
    } catch (err) {
      console.warn(`Could not fetch domain expiry info:`, err.message);
    }
  }

  // ── SSE Progress ──────────────────────────────────────────────────────

  /**
   * Register an SSE client for a domain's provisioning progress.
   */
  addSseClient(domainId, res) {
    if (!this._sseClients.has(domainId)) {
      this._sseClients.set(domainId, []);
    }
    this._sseClients.get(domainId).push(res);

    // Remove on disconnect
    res.on('close', () => {
      const clients = this._sseClients.get(domainId) || [];
      const index = clients.indexOf(res);
      if (index !== -1) clients.splice(index, 1);
      if (clients.length === 0) this._sseClients.delete(domainId);
    });
  }

  _emitProgress(domainId, step, stepIndex, totalSteps, error = null) {
    const clients = this._sseClients.get(domainId) || [];
    const data = JSON.stringify({
      step,
      stepIndex,
      totalSteps,
      progress: totalSteps > 0 ? Math.round(((stepIndex + 1) / totalSteps) * 100) : 0,
      error,
      timestamp: new Date().toISOString(),
    });

    for (const client of clients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch (err) {
        // Client disconnected
      }
    }
  }

  // ── Teardown ──────────────────────────────────────────────────────────

  /**
   * Tear down all infrastructure for a domain.
   */
  async teardown(domainId) {
    const domain = await this._getDomain(domainId);
    if (!domain) return;

    console.log(`🗑️ Tearing down infrastructure for ${domain.domain}`);

    // Delete in reverse order: CloudFront → ACM → Route 53
    if (domain.cloudfront_distribution_id) {
      try {
        await this.infraService.deleteDistribution(domain.cloudfront_distribution_id);
      } catch (err) {
        console.error(`Failed to delete CloudFront:`, err.message);
      }
    }

    if (domain.acm_certificate_arn) {
      try {
        await this.infraService.deleteCertificate(domain.acm_certificate_arn);
      } catch (err) {
        console.error(`Failed to delete ACM cert:`, err.message);
      }
    }

    if (domain.route53_hosted_zone_id) {
      try {
        await this.infraService.deleteHostedZone(domain.route53_hosted_zone_id);
      } catch (err) {
        console.error(`Failed to delete Route 53 zone:`, err.message);
      }
    }

    console.log(`✅ Infrastructure torn down for ${domain.domain}`);
  }

  /**
   * Change which published site a domain points to.
   */
  async changeSite(domainId, newSubdomain) {
    const domain = await this._getDomain(domainId);
    if (!domain) throw new Error('Domain not found');
    if (domain.status !== 'active') throw new Error('Domain must be active to change site');
    if (!domain.cloudfront_distribution_id) throw new Error('No CloudFront distribution found');

    await this.infraService.updateDistributionOrigin(
      domain.cloudfront_distribution_id,
      newSubdomain
    );

    await this._updateDomain(domainId, {
      subdomain: newSubdomain,
    });

    console.log(`✅ Domain ${domain.domain} now points to ${newSubdomain}`);
  }

  // ── Polling Helpers ───────────────────────────────────────────────────

  async _pollForValidationRecords(certArn, maxWait = 60000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const records = await this.infraService.getCertificateValidationRecords(certArn);
      if (records.length > 0) return records;
      await this._sleep(3000);
    }
    throw new Error('Timed out waiting for ACM validation records');
  }

  async _pollCertificateStatus(certArn, maxWait = 300000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const status = await this.infraService.getCertificateStatus(certArn);
      if (status === 'ISSUED') return;
      if (status === 'FAILED') throw new Error('Certificate issuance failed');
      await this._sleep(10000);
    }
    throw new Error('Timed out waiting for certificate to be issued');
  }

  async _pollDistributionStatus(distributionId, maxWait = 900000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const status = await this.infraService.getDistributionStatus(distributionId);
      if (status === 'Deployed') return;
      await this._sleep(15000);
    }
    throw new Error('Timed out waiting for CloudFront distribution to deploy');
  }

  // ── Database Helpers ──────────────────────────────────────────────────

  async _getDomain(domainId) {
    const { data, error } = await this.supabase
      .from('custom_domains')
      .select('*')
      .eq('id', domainId)
      .single();

    if (error) {
      console.error('Error fetching domain:', error);
      return null;
    }
    return data;
  }

  async _updateStatus(domainId, status) {
    await this._updateDomain(domainId, { status });
  }

  async _updateDomain(domainId, fields) {
    const { error } = await this.supabase
      .from('custom_domains')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', domainId);

    if (error) {
      console.error(`Error updating domain ${domainId}:`, error);
      throw error;
    }
  }

  _getResumeIndex(currentStatus) {
    if (currentStatus === 'payment_pending') return 0;
    const index = STEPS.indexOf(currentStatus);
    return index >= 0 ? index : 0;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = DomainOrchestrator;
