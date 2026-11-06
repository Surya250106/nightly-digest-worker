FROM node:20-alpine

WORKDIR /app

# Copy dependency manifests first for build layer caching
COPY package*.json ./

# Install production and development dependencies needed for runtime
RUN npm ci

# Copy application source code and SQL schemas
COPY . .

# Expose API port
EXPOSE 3000

# Default command starts the API server
CMD ["node", "src/api/server.js"]
