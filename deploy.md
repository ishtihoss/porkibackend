# Deploy related code goes here
ssh -i my-key-pair.pem ubuntu@13.216.62.26

docker build -t porkr/porkibackend:latest .

docker push porkr/porkibackend:latest

docker pull porkr/porkibackend:latest

docker run -d \
    --name porkibackend \
    --restart unless-stopped \
    -p 80:80 \
    -p 443:443 \
    --env-file .env \
    -v /etc/letsencrypt:/etc/letsencrypt:ro \
    -v /var/www/certbot:/var/www/certbot \
    porkr/porkibackend:latest



sudo certbot certonly --standalone -d server.porkicoder.com --email payme@ishti.org --agree-tos --no-eff-email


nano ~/.env
cat ~/.env