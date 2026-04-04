const { Route53Client, CreateHostedZoneCommand, DeleteHostedZoneCommand, ChangeResourceRecordSetsCommand, GetHostedZoneCommand } = require('@aws-sdk/client-route-53');
const { ACMClient, RequestCertificateCommand, DescribeCertificateCommand, DeleteCertificateCommand } = require('@aws-sdk/client-acm');
const { CloudFrontClient, CreateDistributionCommand, GetDistributionCommand, DeleteDistributionCommand, UpdateDistributionCommand, CreateInvalidationCommand } = require('@aws-sdk/client-cloudfront');

const SUPABASE_ORIGIN = 'ptamafzwvxtmvljnhsdx.supabase.co';
const SUPABASE_ORIGIN_PATH_PREFIX = '/storage/v1/object/public/published-sites';

class DomainInfraService {
  constructor() {
    const region = process.env.AWS_REGION || 'us-east-1';

    this.route53 = new Route53Client({ region });
    // ACM certs for CloudFront MUST be in us-east-1
    this.acm = new ACMClient({ region: 'us-east-1' });
    this.cloudfront = new CloudFrontClient({ region: 'us-east-1' });
  }

  // ── Route 53 ────────────────��─────────────────────────────────────────

  /**
   * Create a hosted zone for the domain.
   * Returns: { hostedZoneId, nameservers }
   */
  async createHostedZone(domain) {
    console.log(`🌐 Creating Route 53 hosted zone for: ${domain}`);

    const command = new CreateHostedZoneCommand({
      Name: domain,
      CallerReference: `porkicoder-${domain}-${Date.now()}`,
      HostedZoneConfig: {
        Comment: `Managed by PorkiCoder for ${domain}`,
      },
    });

    const response = await this.route53.send(command);
    const hostedZoneId = response.HostedZone.Id.replace('/hostedzone/', '');
    const nameservers = response.DelegationSet.NameServers;

    console.log(`✅ Hosted zone created: ${hostedZoneId}`);
    console.log(`   Nameservers: ${nameservers.join(', ')}`);

    return { hostedZoneId, nameservers };
  }

  /**
   * Add DNS records to Route 53 hosted zone.
   * Used for: A record pointing to CloudFront, CNAME for ACM validation.
   */
  async addDnsRecords(hostedZoneId, records) {
    console.log(`📝 Adding ${records.length} DNS record(s) to zone ${hostedZoneId}`);

    const changes = records.map(record => ({
      Action: 'UPSERT',
      ResourceRecordSet: {
        Name: record.name,
        Type: record.type,
        TTL: record.ttl || 300,
        ...(record.aliasTarget
          ? {
              AliasTarget: {
                HostedZoneId: record.aliasTarget.hostedZoneId,
                DNSName: record.aliasTarget.dnsName,
                EvaluateTargetHealth: false,
              },
            }
          : {
              ResourceRecords: record.values.map(v => ({ Value: v })),
            }),
      },
    }));

    const command = new ChangeResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      ChangeBatch: { Changes: changes },
    });

    await this.route53.send(command);
    console.log(`✅ DNS records added`);
  }

  /**
   * Delete a hosted zone. Must remove all non-default records first.
   */
  async deleteHostedZone(hostedZoneId) {
    console.log(`🗑️ Deleting hosted zone: ${hostedZoneId}`);

    try {
      const command = new DeleteHostedZoneCommand({
        Id: hostedZoneId,
      });
      await this.route53.send(command);
      console.log(`✅ Hosted zone deleted: ${hostedZoneId}`);
    } catch (err) {
      console.error(`Failed to delete hosted zone ${hostedZoneId}:`, err.message);
      throw err;
    }
  }

  // ── ACM (SSL Certificates) ─────────────���──────────────────────────────

  /**
   * Request an SSL certificate for the domain (+ www subdomain).
   * Uses DNS validation — we'll add the validation records to Route 53.
   * Returns: { certificateArn }
   */
  async requestCertificate(domain) {
    console.log(`🔒 Requesting ACM certificate for: ${domain}, www.${domain}`);

    const command = new RequestCertificateCommand({
      DomainName: domain,
      SubjectAlternativeNames: [domain, `www.${domain}`],
      ValidationMethod: 'DNS',
      Tags: [
        { Key: 'ManagedBy', Value: 'PorkiCoder' },
        { Key: 'Domain', Value: domain },
      ],
    });

    const response = await this.acm.send(command);
    const certificateArn = response.CertificateArn;

    console.log(`✅ Certificate requested: ${certificateArn}`);
    return { certificateArn };
  }

  /**
   * Get the DNS validation records needed for ACM certificate.
   * Must poll this — validation records aren't immediately available.
   * Returns: [{ name, type, value }]
   */
  async getCertificateValidationRecords(certificateArn) {
    const command = new DescribeCertificateCommand({
      CertificateArn: certificateArn,
    });

    const response = await this.acm.send(command);
    const cert = response.Certificate;

    if (!cert.DomainValidationOptions) {
      return [];
    }

    const records = [];
    const seen = new Set();

    for (const option of cert.DomainValidationOptions) {
      if (option.ResourceRecord) {
        const key = option.ResourceRecord.Name;
        if (!seen.has(key)) {
          seen.add(key);
          records.push({
            name: option.ResourceRecord.Name,
            type: option.ResourceRecord.Type,
            values: [option.ResourceRecord.Value],
            ttl: 300,
          });
        }
      }
    }

    return records;
  }

  /**
   * Check the status of an ACM certificate.
   * Returns: 'PENDING_VALIDATION' | 'ISSUED' | 'FAILED' | etc.
   */
  async getCertificateStatus(certificateArn) {
    const command = new DescribeCertificateCommand({
      CertificateArn: certificateArn,
    });

    const response = await this.acm.send(command);
    return response.Certificate.Status;
  }

  /**
   * Delete an ACM certificate.
   */
  async deleteCertificate(certificateArn) {
    console.log(`🗑️ Deleting ACM certificate: ${certificateArn}`);
    try {
      const command = new DeleteCertificateCommand({
        CertificateArn: certificateArn,
      });
      await this.acm.send(command);
      console.log(`✅ Certificate deleted`);
    } catch (err) {
      console.error(`Failed to delete certificate:`, err.message);
    }
  }

  // ── CloudFront ───────��────────────────────────────────────────────────

  /**
   * Create a CloudFront distribution for the custom domain.
   * Origin: Supabase Storage, serving the published site files.
   * Returns: { distributionId, domainName }
   */
  async createDistribution(domain, subdomain, certificateArn) {
    console.log(`☁️ Creating CloudFront distribution for: ${domain} → ${subdomain}`);

    const originId = `supabase-${subdomain}`;

    const command = new CreateDistributionCommand({
      DistributionConfig: {
        CallerReference: `porkicoder-${domain}-${Date.now()}`,
        Comment: `PorkiCoder: ${domain} → ${subdomain}.porkicoder.com`,
        Enabled: true,

        Aliases: {
          Quantity: 2,
          Items: [domain, `www.${domain}`],
        },

        Origins: {
          Quantity: 1,
          Items: [{
            Id: originId,
            DomainName: SUPABASE_ORIGIN,
            OriginPath: `${SUPABASE_ORIGIN_PATH_PREFIX}/${subdomain}`,
            CustomOriginConfig: {
              HTTPPort: 80,
              HTTPSPort: 443,
              OriginProtocolPolicy: 'https-only',
              OriginSslProtocols: { Quantity: 1, Items: ['TLSv1.2'] },
            },
          }],
        },

        DefaultCacheBehavior: {
          TargetOriginId: originId,
          ViewerProtocolPolicy: 'redirect-to-https',
          AllowedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] },
          CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] },
          Compress: true,
          ForwardedValues: {
            QueryString: false,
            Cookies: { Forward: 'none' },
          },
          MinTTL: 0,
          DefaultTTL: 86400,    // 1 day
          MaxTTL: 31536000,     // 1 year
        },

        DefaultRootObject: 'index.html',

        // SPA support: serve index.html for 404s
        CustomErrorResponses: {
          Quantity: 1,
          Items: [{
            ErrorCode: 404,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
            ErrorCachingMinTTL: 300,
          }],
        },

        ViewerCertificate: {
          ACMCertificateArn: certificateArn,
          SSLSupportMethod: 'sni-only',
          MinimumProtocolVersion: 'TLSv1.2_2021',
        },

        HttpVersion: 'http2and3',
        PriceClass: 'PriceClass_100', // US, Canada, Europe (cheapest)

        Restrictions: {
          GeoRestriction: { RestrictionType: 'none', Quantity: 0 },
        },
      },
    });

    const response = await this.cloudfront.send(command);
    const distributionId = response.Distribution.Id;
    const domainName = response.Distribution.DomainName;

    console.log(`✅ CloudFront distribution created: ${distributionId} (${domainName})`);
    return { distributionId, domainName };
  }

  /**
   * Check CloudFront distribution deployment status.
   * Returns: 'Deployed' | 'InProgress'
   */
  async getDistributionStatus(distributionId) {
    const command = new GetDistributionCommand({ Id: distributionId });
    const response = await this.cloudfront.send(command);
    return response.Distribution.Status;
  }

  /**
   * Update CloudFront distribution origin path (when user changes which site the domain points to).
   */
  async updateDistributionOrigin(distributionId, newSubdomain) {
    console.log(`🔄 Updating CloudFront origin for ${distributionId} → ${newSubdomain}`);

    // Get current config
    const getCommand = new GetDistributionCommand({ Id: distributionId });
    const current = await this.cloudfront.send(getCommand);
    const config = current.Distribution.DistributionConfig;
    const etag = current.ETag;

    // Update origin path
    config.Origins.Items[0].OriginPath = `${SUPABASE_ORIGIN_PATH_PREFIX}/${newSubdomain}`;

    const updateCommand = new UpdateDistributionCommand({
      Id: distributionId,
      IfMatch: etag,
      DistributionConfig: config,
    });

    await this.cloudfront.send(updateCommand);
    console.log(`✅ Distribution origin updated`);

    // Invalidate cache
    await this.invalidateDistribution(distributionId);
  }

  /**
   * Invalidate all cached content in a CloudFront distribution.
   */
  async invalidateDistribution(distributionId) {
    console.log(`🧹 Invalidating cache for distribution ${distributionId}`);

    const command = new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: `invalidate-${Date.now()}`,
        Paths: {
          Quantity: 1,
          Items: ['/*'],
        },
      },
    });

    await this.cloudfront.send(command);
    console.log(`✅ Cache invalidation created`);
  }

  /**
   * Disable and delete a CloudFront distribution.
   * CloudFront requires disabling before deletion.
   */
  async deleteDistribution(distributionId) {
    console.log(`🗑️ Deleting CloudFront distribution: ${distributionId}`);

    try {
      // First disable it
      const getCommand = new GetDistributionCommand({ Id: distributionId });
      const current = await this.cloudfront.send(getCommand);
      const config = current.Distribution.DistributionConfig;
      let etag = current.ETag;

      if (config.Enabled) {
        config.Enabled = false;
        const disableCommand = new UpdateDistributionCommand({
          Id: distributionId,
          IfMatch: etag,
          DistributionConfig: config,
        });
        const disableResponse = await this.cloudfront.send(disableCommand);
        etag = disableResponse.ETag;
        console.log(`   Distribution disabled, waiting for deployment...`);

        // Wait for distribution to be disabled (can take several minutes)
        await this._waitForDistributionDeployed(distributionId);

        // Re-fetch etag after deployment
        const refreshed = await this.cloudfront.send(getCommand);
        etag = refreshed.ETag;
      }

      // Now delete
      const deleteCommand = new DeleteDistributionCommand({
        Id: distributionId,
        IfMatch: etag,
      });
      await this.cloudfront.send(deleteCommand);
      console.log(`✅ Distribution deleted: ${distributionId}`);
    } catch (err) {
      console.error(`Failed to delete distribution ${distributionId}:`, err.message);
      throw err;
    }
  }

  /**
   * Add Route 53 alias records pointing domain to CloudFront distribution.
   */
  async addCloudFrontAliasRecords(hostedZoneId, domain, cloudfrontDomainName) {
    // CloudFront hosted zone ID is always Z2FDTNDATAQYW2
    const cloudfrontHostedZoneId = 'Z2FDTNDATAQYW2';

    const records = [
      {
        name: domain,
        type: 'A',
        aliasTarget: {
          hostedZoneId: cloudfrontHostedZoneId,
          dnsName: cloudfrontDomainName,
        },
      },
      {
        name: `www.${domain}`,
        type: 'A',
        aliasTarget: {
          hostedZoneId: cloudfrontHostedZoneId,
          dnsName: cloudfrontDomainName,
        },
      },
    ];

    await this.addDnsRecords(hostedZoneId, records);
  }

  // ── Helpers ───────��───────────────────────────────────────────────────

  async _waitForDistributionDeployed(distributionId, maxWait = 600000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const status = await this.getDistributionStatus(distributionId);
      if (status === 'Deployed') return;
      await new Promise(resolve => setTimeout(resolve, 15000)); // poll every 15s
    }
    throw new Error(`Distribution ${distributionId} did not deploy within ${maxWait / 1000}s`);
  }
}

module.exports = DomainInfraService;
