# EPZR Student Connect — Node app (landing page + application form + QR generator)
FROM node:22-alpine
ENV NODE_ENV=production PORT=80 DATA_DIR=/data TZ=Asia/Dubai
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY templates ./templates
COPY public ./public
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1/health || exit 1
CMD ["node", "server.js"]
