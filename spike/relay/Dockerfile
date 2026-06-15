FROM node:22-alpine
RUN apk add --no-cache git
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# noVNC completo (core/ + vendor/) vendorizado de uma tag estável.
RUN git clone --depth 1 --branch v1.5.0 https://github.com/novnc/noVNC.git /app/novnc

COPY relay.mjs ./
ENV NOVNC_DIR=/app/novnc
ENV SPIKE_RELAY_PORT=7700
EXPOSE 7700
CMD ["node", "relay.mjs"]
