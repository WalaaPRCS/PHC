FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY db ./db
COPY public ./public
COPY docker/start-app.sh /usr/local/bin/start-app
RUN chmod 0555 /usr/local/bin/start-app
EXPOSE 8080
USER node
ENTRYPOINT ["/usr/local/bin/start-app"]
