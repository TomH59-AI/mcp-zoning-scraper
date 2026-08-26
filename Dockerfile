FROM mcr.microsoft.com/playwright:v1.62.0-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY tools ./tools

RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production

CMD ["node", "dist/src/server.js"]
