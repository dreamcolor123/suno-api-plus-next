# HTTPS deployment

The Next.js container serves plain HTTP on `127.0.0.1:3000`. Terminate TLS at
Nginx (or Caddy) and forward the request to that local port.

## Nginx + Let's Encrypt

Replace `suno.example.com` in `deploy/nginx/suno-api.conf` with your domain,
make sure DNS points to the server, then run:

```bash
sudo apt-get update
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx/suno-api.conf /etc/nginx/sites-available/suno-api.conf
sudo ln -sfn /etc/nginx/sites-available/suno-api.conf /etc/nginx/sites-enabled/suno-api.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d suno.example.com --redirect
```

Start the app with the default secure binding:

```bash
docker compose build
docker compose up -d
```

The public API URL is then:

```text
https://suno.example.com/v1
```

For local-only testing without a reverse proxy, use the explicit override:

```bash
docker compose -f docker-compose.yml -f docker-compose.http.yml up -d
```

The proxy must forward `Host`, `X-Forwarded-Host`, and
`X-Forwarded-Proto`. This keeps admin session cookies secure and preserves
OpenAI-compatible streaming connections.
