FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY db ./db
COPY public ./public
EXPOSE 8080
USER node
CMD ["npm", "start"]
