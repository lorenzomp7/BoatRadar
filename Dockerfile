# Server BoatRadar per la VM Oracle (vedi deploy/). La pagina pubblica sta su GitHub Pages.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8765
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js position-check.js sample.js boatradar.html vesselfinder.html ./
COPY public/ais-logic.js ./public/
USER node
EXPOSE 8765
CMD ["node", "server.js"]
