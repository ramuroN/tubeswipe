# TubeSwipe: nur Node, keine Pakete. Alles, was die App schreibt, liegt in /data.
FROM node:22-alpine

WORKDIR /app
COPY server.js COMMIT* ./
COPY public ./public

ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
RUN mkdir /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health > /dev/null || exit 1
CMD ["node", "server.js"]
