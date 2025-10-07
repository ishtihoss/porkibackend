FROM node:20.13.1-alpine

# Install Nginx and OpenSSL
RUN apk add --no-cache nginx openssl

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY src/ ./src/

# Copy Nginx configuration
COPY nginx.backend.conf /etc/nginx/http.d/default.conf

# Create directory for Let's Encrypt challenges (will be overridden by volume mount)
RUN mkdir -p /var/www/certbot/.well-known/acme-challenge

# Create nginx user and set permissions
RUN adduser -D -g 'nginx' nginx || true
RUN chown -R nginx:nginx /var/www

# Copy and make the entrypoint script executable
COPY entrypoint.sh .
RUN chmod +x ./entrypoint.sh

# Expose both HTTP and HTTPS ports
EXPOSE 80 443

# Run the entrypoint script
CMD ["./entrypoint.sh"]
