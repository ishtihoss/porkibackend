const { createClient } = require('@supabase/supabase-js');

const RESERVED_SUBDOMAINS = new Set([
  'www', 'server', 'admin', 'api', 'app', 'mail', 'ftp',
  'cdn', 'static', 'status', 'docs', 'blog', 'help', 'support',
]);

const DANGEROUS_FILE_PATTERNS = [
  /^\.env/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,
  /^credentials/i,
  /\.secret$/i,
];

const MAX_FILES = 500;
const MAX_TOTAL_SIZE_BYTES = 50 * 1024 * 1024; // 50MB decoded
const MAX_SITES_PER_USER = 3;
const MAX_DEPLOYS_PER_HOUR = 10;
const BUCKET_NAME = 'published-sites';

class PublishService {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    // In-memory deploy rate limiting: userId -> [timestamps]
    this._deployTimestamps = new Map();
  }

  /**
   * Check if a subdomain is available
   */
  async checkSubdomain(userId, subdomain) {
    const formatError = this._validateSubdomainFormat(subdomain);
    if (formatError) return { available: false, reason: formatError };

    const isPremium = await this._isPremium(userId);
    if (!isPremium) {
      return { available: false, reason: 'Publishing requires PorkiCoder Premium.' };
    }

    // Check if subdomain is taken by another user
    const { data, error } = await this.supabase
      .from('published_sites')
      .select('user_id')
      .eq('subdomain', subdomain)
      .maybeSingle();

    if (error) throw new Error('Failed to check subdomain availability');

    if (data && data.user_id !== userId) {
      return { available: false, reason: 'This subdomain is already taken.' };
    }

    return { available: true, isUpdate: !!data };
  }

  /**
   * Deploy files to a subdomain
   */
  async deploy(userId, subdomain, files) {
    // Premium check
    const isPremium = await this._isPremium(userId);
    if (!isPremium) {
      return { error: 'PREMIUM_REQUIRED', message: 'Publishing requires PorkiCoder Premium.' };
    }

    // Rate limit
    if (this._isRateLimited(userId)) {
      return { error: 'RATE_LIMITED', message: 'Too many deploys. Please wait before trying again.' };
    }

    // Subdomain format
    const formatError = this._validateSubdomainFormat(subdomain);
    if (formatError) {
      return { error: 'INVALID_SUBDOMAIN', message: formatError };
    }

    // Check ownership — subdomain must be available or owned by this user
    const { data: existing } = await this.supabase
      .from('published_sites')
      .select('user_id')
      .eq('subdomain', subdomain)
      .maybeSingle();

    if (existing && existing.user_id !== userId) {
      return { error: 'SUBDOMAIN_TAKEN', message: 'This subdomain is already taken.' };
    }

    // Check site limit (only for new sites)
    if (!existing) {
      const { count } = await this.supabase
        .from('published_sites')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);

      if (count >= MAX_SITES_PER_USER) {
        return { error: 'SITE_LIMIT', message: `You can have at most ${MAX_SITES_PER_USER} published sites. Delete one first.` };
      }
    }

    // Validate files
    if (!Array.isArray(files) || files.length === 0) {
      return { error: 'NO_FILES', message: 'No files to publish.' };
    }
    if (files.length > MAX_FILES) {
      return { error: 'TOO_MANY_FILES', message: `Maximum ${MAX_FILES} files allowed.` };
    }

    // Check for dangerous files and path traversal
    for (const file of files) {
      if (file.path.includes('..')) {
        return { error: 'INVALID_PATH', message: `Invalid file path: ${file.path}` };
      }
      const basename = file.path.split('/').pop();
      for (const pattern of DANGEROUS_FILE_PATTERNS) {
        if (pattern.test(basename)) {
          return { error: 'DANGEROUS_FILE', message: `File not allowed: ${file.path}` };
        }
      }
    }

    // Decode and check total size
    let totalSize = 0;
    const decodedFiles = [];
    for (const file of files) {
      const buffer = Buffer.from(file.content, 'base64');
      totalSize += buffer.length;
      if (totalSize > MAX_TOTAL_SIZE_BYTES) {
        return { error: 'TOO_LARGE', message: 'Total site size exceeds 50MB limit.' };
      }
      decodedFiles.push({ path: file.path, buffer, mimeType: file.mimeType });
    }

    // If updating, clean old files first
    if (existing) {
      await this._cleanBucket(subdomain);
    }

    // Upload all files to Supabase Storage
    const errors = [];
    for (const file of decodedFiles) {
      const storagePath = `${subdomain}/${file.path}`;
      const { error: uploadError } = await this.supabase.storage
        .from(BUCKET_NAME)
        .upload(storagePath, file.buffer, {
          contentType: file.mimeType || 'application/octet-stream',
          upsert: true,
        });

      if (uploadError) {
        console.error(`Upload error for ${storagePath}:`, uploadError.message);
        errors.push(file.path);
      }
    }

    if (errors.length === decodedFiles.length) {
      return { error: 'UPLOAD_FAILED', message: 'Failed to upload files. Please try again.' };
    }

    // Upsert site record
    const { error: dbError } = await this.supabase
      .from('published_sites')
      .upsert({
        user_id: userId,
        subdomain,
        file_count: decodedFiles.length - errors.length,
        total_size_bytes: totalSize,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'subdomain' });

    if (dbError) {
      console.error('DB upsert error:', dbError.message);
    }

    // Track deploy timestamp
    this._recordDeploy(userId);

    const url = `https://${subdomain}.porkicoder.com`;
    console.log(`Published site: ${url} (${decodedFiles.length} files, ${Math.round(totalSize / 1024)}KB)`);

    return {
      success: true,
      url,
      fileCount: decodedFiles.length - errors.length,
      totalSize,
      partialErrors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * List user's published sites
   */
  async listSites(userId) {
    const { data, error } = await this.supabase
      .from('published_sites')
      .select('subdomain, file_count, total_size_bytes, created_at, updated_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw new Error('Failed to fetch published sites');

    return (data || []).map(site => ({
      subdomain: site.subdomain,
      url: `https://${site.subdomain}.porkicoder.com`,
      fileCount: site.file_count,
      totalSize: site.total_size_bytes,
      createdAt: site.created_at,
      updatedAt: site.updated_at,
    }));
  }

  /**
   * Delete a published site
   */
  async deleteSite(userId, subdomain) {
    // Verify ownership
    const { data, error } = await this.supabase
      .from('published_sites')
      .select('user_id')
      .eq('subdomain', subdomain)
      .maybeSingle();

    if (error) throw new Error('Failed to look up site');
    if (!data) return { error: 'NOT_FOUND', message: 'Site not found.' };
    if (data.user_id !== userId) return { error: 'FORBIDDEN', message: 'You do not own this site.' };

    // Delete files from storage
    await this._cleanBucket(subdomain);

    // Delete DB record
    await this.supabase
      .from('published_sites')
      .delete()
      .eq('subdomain', subdomain)
      .eq('user_id', userId);

    console.log(`Deleted site: ${subdomain}.porkicoder.com`);
    return { success: true };
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  _validateSubdomainFormat(subdomain) {
    if (!subdomain || typeof subdomain !== 'string') return 'Subdomain is required.';
    if (subdomain.length < 3) return 'Subdomain must be at least 3 characters.';
    if (subdomain.length > 63) return 'Subdomain must be 63 characters or fewer.';
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(subdomain) && !/^[a-z0-9]{1,2}$/.test(subdomain)) {
      return 'Subdomain must be lowercase letters, numbers, and hyphens. Cannot start or end with a hyphen.';
    }
    if (RESERVED_SUBDOMAINS.has(subdomain)) return 'This subdomain is reserved.';
    return null;
  }

  async _isPremium(userId) {
    const { data, error } = await this.supabase
      .from('user_request_limits')
      .select('is_premium')
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !data) return false;
    return !!data.is_premium;
  }

  async _cleanBucket(subdomain) {
    const allPaths = await this._listAllFiles(subdomain);
    if (allPaths.length === 0) return;

    // Supabase Storage remove() accepts max 1000 paths per call
    for (let i = 0; i < allPaths.length; i += 1000) {
      const batch = allPaths.slice(i, i + 1000);
      const { error: removeError } = await this.supabase.storage
        .from(BUCKET_NAME)
        .remove(batch);

      if (removeError) {
        console.error(`Error cleaning bucket for ${subdomain}:`, removeError.message);
      }
    }
  }

  async _listAllFiles(prefix, collected = []) {
    const { data, error } = await this.supabase.storage
      .from(BUCKET_NAME)
      .list(prefix, { limit: 1000 });

    if (error || !data) return collected;

    for (const item of data) {
      const fullPath = `${prefix}/${item.name}`;
      // Supabase Storage: files have an `id` field, folders do not
      if (item.id) {
        collected.push(fullPath);
      } else {
        // It's a folder — recurse into it
        await this._listAllFiles(fullPath, collected);
      }
    }

    return collected;
  }

  _isRateLimited(userId) {
    const now = Date.now();
    const timestamps = this._deployTimestamps.get(userId) || [];
    const recent = timestamps.filter(t => now - t < 3600000); // last hour
    return recent.length >= MAX_DEPLOYS_PER_HOUR;
  }

  _recordDeploy(userId) {
    const now = Date.now();
    const timestamps = this._deployTimestamps.get(userId) || [];
    timestamps.push(now);
    // Keep only last hour
    this._deployTimestamps.set(userId, timestamps.filter(t => now - t < 3600000));
  }
}

module.exports = PublishService;
