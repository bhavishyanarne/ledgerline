# LedgerLine — Production Dockerfile
FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Create data directory for SQLite WAL storage
RUN mkdir -p /app/data

# Environment Defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/ledger.db

EXPOSE 3000

CMD ["node", "server.js"]
