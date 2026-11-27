# Server BoatRadar per la VM Oracle (vedi deploy/). La pagina pubblica sta su GitHub Pages.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8765
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js position-check.js sample.js snapshot.js boatradar.html vesselfinder.html ./
COPY public/ais-logic.js ./public/
# Leaflet 1.9.4 servito dalla repo (punto 85); LICENSE (BSD-2-Clause) va con i file, ma server.js non la serve
COPY vendor/leaflet/leaflet.js vendor/leaflet/leaflet.css vendor/leaflet/LICENSE ./vendor/leaflet/
COPY vendor/leaflet/images/ ./vendor/leaflet/images/
# dati statici fra un riavvio e l'altro (punto 22): /data è il volume di deploy/compose.yml, dell'utente node
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8765
CMD ["node", "server.js"]
